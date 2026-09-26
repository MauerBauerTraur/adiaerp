/**
 * Poster integration routes (spec section 4.9 + ADR-0002):
 *
 *   POST /api/integrations/poster/webhook[/:secret]   — no JWT; secret-token gated
 *   POST /api/integrations/poster/sync                — pm; ?entity=all|locations|products|stock|sales
 *   GET  /api/integrations/poster/status              — pm; recent poster_sync_log rows
 *   GET  /api/integrations/poster/product-recipe/:id  — pm, production_manager; preview
 *   POST /api/integrations/poster/product-recipe/:id/apply
 *                                                     — pm, production_manager; re-sync + unlock
 *   /api/integrations/poster/recipe-audit[/run|/apply|/restore|/job]
 *                                                     — bulk audit/apply/restore (routes/posterRecipeAudit.ts)
 *
 * Webhook auth (TZ OS-6 — until Poster documents an HMAC signature):
 *   Poster lets us configure ANY URL as its webhook target. We embed an
 *   unguessable secret in the URL path (`/webhook/<POSTER_WEBHOOK_SECRET>`)
 *   or in `?secret=<...>`. The handler compares with `timingSafeEqual` and
 *   stores the raw payload — the actual ingestion is async in
 *   `processPendingWebhookEvents` (`posterSalesSync` worker).
 */
import { Router, type Request, type RequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { loadConfig } from '../config/index.js';
import { query } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getPrincipal } from '../lib/principal.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { createPosterClientFromConfig } from '../integrations/poster/client.js';
import { RECIPE_LOCK_BUSY_MESSAGE, acquirePosterRecipeLock } from '../integrations/poster/recipeLock.js';
import {
  findPosterRecipe,
  planRecipeRows,
  readRecipeSnapshot,
  type ErpProductRef,
} from '../integrations/poster/posterRecipe.js';
import { poolRunner } from '../lib/audit.js';
import {
  NO_USABLE_LINES_MESSAGE,
  applyPosterRecipe,
  buildForProduct,
  missingRecipeMessage,
  notFoundMessage,
  requirePosterRecipeReader,
} from '../services/posterRecipeApply.js';
import { posterRecipeAuditRouter } from './posterRecipeAudit.js';
import {
  runSeedSync,
  syncSpots,
  syncStorages,
  syncIngredients,
  syncPrepacks,
  syncMenuProducts,
  syncWorkshops,
  syncProductWorkshops,
  type SeedSelector,
} from '../integrations/poster/seedSync.js';
import { syncStockLeftovers } from '../integrations/poster/stockSync.js';
import { fallbackPollTransactions } from '../integrations/poster/salesSync.js';
import { checkSoldProductsAndCreateOrders } from '../services/autoOrder.js';
import { recalculateBomCosts } from '../services/costCalc.js';

export const posterIntegrationRouter: Router = Router();

// -----------------------------------------------------------------------------
// 4.9.1 Webhook endpoint — JWT-less; URL-token gated.
// -----------------------------------------------------------------------------

/**
 * Constant-time secret compare. Returns false when either side is empty so an
 * unconfigured webhook secret never authorises a caller by accident.
 */
function verifyWebhookSecret(received: string | undefined): boolean {
  const expected = loadConfig().poster.webhookSecret;
  if (expected === '' || received === undefined || received === '') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readSecret(req: Request): string | undefined {
  // Accept both `/webhook/<secret>` (path param) and `?secret=<secret>` (query).
  const fromPath = typeof req.params.secret === 'string' ? req.params.secret : undefined;
  const fromQuery = typeof req.query.secret === 'string' ? req.query.secret : undefined;
  return fromPath ?? fromQuery;
}

async function ingestWebhook(req: Request): Promise<void> {
  // Poster sends form-encoded by default, but the docs allow JSON. We accept
  // whatever Express has parsed; otherwise fall back to the raw body if any.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const eventType =
    typeof body.action === 'string' ? body.action :
    typeof body.event_type === 'string' ? body.event_type :
    typeof body.object_type === 'string' ? `${body.object_type}.${body.action ?? 'update'}` :
    'unknown';
  const posterObjectId =
    typeof body.object_id === 'string' || typeof body.object_id === 'number'
      ? Number(body.object_id)
      : typeof body.transaction_id === 'string' || typeof body.transaction_id === 'number'
      ? Number(body.transaction_id)
      : null;
  await query(
    `INSERT INTO poster_webhook_events (event_type, poster_object_id, payload)
     VALUES ($1, $2, $3)`,
    [eventType, Number.isInteger(posterObjectId) ? posterObjectId : null, JSON.stringify(body)],
  );
}

/**
 * C4 (Sprint 3 audit) — per-IP rate limit on the webhook endpoint.
 *
 * The webhook endpoint runs without JWT (Poster cannot send headers), so the
 * only gate is the URL secret. A leaked secret + a high-volume DoS would
 * otherwise flood `poster_webhook_events`. Cap each IP at 60 requests/min;
 * over the limit -> 429 (Poster retries silently). Disabled under `test` so
 * suites that exercise the endpoint in a tight loop are not throttled.
 *
 * Note: deploy may also add an nginx-layer zone limit (ADR-0002 §13). The
 * application-layer cap is the in-process belt-and-braces.
 */
const webhookRateLimit: RequestHandler =
  loadConfig().nodeEnv === 'test'
    ? (_req, _res, next): void => next()
    : rateLimit({
        windowMs: 60 * 1000, // 1 minute
        limit: 60,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (_req, res): void => {
          res.status(429).json({
            error: {
              code: 'RATE_LIMITED',
              message: 'Webhook rate limit exceeded — retry later.',
            },
          });
        },
      });

const webhookHandler = asyncHandler(async (req, res) => {
  if (!verifyWebhookSecret(readSecret(req))) {
    // Do NOT leak the reason — log internally, return 401 to Poster.
    res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'invalid webhook secret' } });
    return;
  }
  await ingestWebhook(req);
  // Quick 200 — actual processing is async (`posterSalesSync` worker).
  res.status(200).json({ received: true });
});

posterIntegrationRouter.post('/webhook', webhookRateLimit, webhookHandler);
posterIntegrationRouter.post('/webhook/:secret', webhookRateLimit, webhookHandler);

// -----------------------------------------------------------------------------
// 4.9.2 Manual full sync — pm only.
// -----------------------------------------------------------------------------

const ENTITY_VALUES: readonly (SeedSelector | 'stock' | 'sales' | 'costs' | 'workshops' | 'auto-orders')[] = [
  'all',
  'locations',
  'products',
  'stock',
  'sales',
  'costs',
  'workshops',
  'auto-orders',
];

posterIntegrationRouter.post(
  '/sync',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const entityRaw = typeof req.query.entity === 'string' ? req.query.entity : 'all';
    if (!ENTITY_VALUES.includes(entityRaw as (typeof ENTITY_VALUES)[number])) {
      throw AppError.validation(`Query "entity" must be one of: ${ENTITY_VALUES.join(', ')}.`);
    }
    // Validate token exists after entity validation so we return a clean error
    // instead of a raw Poster error code 10.
    const cfg = loadConfig();
    if (cfg.poster.token === '') {
      throw AppError.internal('POSTER_TOKEN is not configured — cannot run sync.');
    }
    const client = createPosterClientFromConfig();
    // products / all rewrite recipes: share the recipe lock with the hourly
    // recipe sync and the bulk apply/restore job (review R5). Other entities
    // never touch recipes and run freely.
    const needsRecipeLock = entityRaw === 'products' || entityRaw === 'all';
    const held = needsRecipeLock ? await acquirePosterRecipeLock() : null;
    if (needsRecipeLock && held === null) throw AppError.conflict(RECIPE_LOCK_BUSY_MESSAGE);
    const out: unknown[] = [];
    try {
      switch (entityRaw) {
        case 'locations':
          out.push(await syncSpots(client, 'manual'));
          out.push(await syncStorages(client, 'manual'));
          out.push((await syncWorkshops(client, 'manual')).result);
          break;
        case 'products':
          out.push(await syncIngredients(client, 'manual'));
          out.push(await syncPrepacks(client, 'manual'));
          out.push(await syncMenuProducts(client, 'manual'));
          break;
        case 'stock': {
          const r = await syncStockLeftovers(client, 'manual');
          out.push({ entity: 'leftovers', ...r });
          // After stock sync refreshes raw material costs, propagate to BOM tree.
          const costResult = await recalculateBomCosts();
          out.push({ entity: 'costs', ...costResult });
          break;
        }
        case 'sales': {
          const r = await fallbackPollTransactions(client, 60);
          out.push({ entity: 'transactions', ...r });
          break;
        }
        case 'costs': {
          // Standalone BOM cost recalculation — no Poster API call needed.
          const costResult = await recalculateBomCosts();
          out.push({ entity: 'costs', ...costResult });
          break;
        }
        case 'workshops': {
          // Dedicated pass: update production_location_id + storage_location_id
          // for all products based on their Poster workshop assignment.
          const workshopResult = await syncProductWorkshops(client, 'manual');
          out.push({ ...workshopResult, entity: 'workshops' });
          break;
        }
        case 'auto-orders': {
          // Manually trigger auto-order check: evaluate all products sold in the
          // last 7 days and create production orders for those below min_qty.
          const aoResult = await checkSoldProductsAndCreateOrders();
          out.push({ entity: 'auto-orders', ...aoResult });
          break;
        }
        case 'all':
        default: {
          out.push(...(await runSeedSync(client, 'all')));
          // After full product sync, apply workshop assignments (covers products
          // that were seeded before locations existed, or had workshop_id=0 before).
          const wResult = await syncProductWorkshops(client, 'manual');
          out.push({ ...wResult, entity: 'workshops' });
          const r = await syncStockLeftovers(client, 'manual');
          out.push({ ...r, entity: 'leftovers' });
          // Propagate freshly-synced raw material costs through the BOM tree.
          const costResult = await recalculateBomCosts();
          out.push({ ...costResult, entity: 'costs' });
          break;
        }
      }
    } finally {
      await held?.release();
    }
    res.status(200).json({ results: out });
  }),
);

// -----------------------------------------------------------------------------

// 4.9.3 Fetch recipe for one product from Poster — pm/production_manager.
// GET /api/integrations/poster/product-recipe/:erpProductId
// Returns the ingredients Poster knows for this product so the user can
// review/import them into the ERP recipe without running a full sync.
// -----------------------------------------------------------------------------

/** Load the ERP product named by `:erpProductId` (422 bad id, 404 missing). */
async function loadErpProduct(rawId: unknown): Promise<ErpProductRef> {
  const productId = Number(rawId);
  if (!Number.isInteger(productId) || productId <= 0) {
    throw AppError.validation("Mahsulot ID noto'g'ri.");
  }
  const { rows } = await query<ErpProductRef>(
    `SELECT id, name, type::text AS type, batch_yield,
            poster_ingredient_id, poster_product_id
       FROM products WHERE id = $1`,
    [productId],
  );
  const erp = rows[0];
  if (erp === undefined) throw AppError.notFound('Mahsulot topilmadi.');
  return erp;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

posterIntegrationRouter.get(
  '/product-recipe/:erpProductId',
  authenticate,
  authorize('pm', 'production_manager'),
  asyncHandler(async (req, res) => {
    const erp = await loadErpProduct(req.params.erpProductId);
    const reader = requirePosterRecipeReader();

    // Same lookup + same build as the apply endpoint, the bulk audit and the
    // hourly sync, so the preview shows exactly what "apply" would write.
    const lookup = await findPosterRecipe(reader, erp);
    if (!lookup.found) {
      res.status(200).json({
        lines: [],
        not_found: [],
        message: missingRecipeMessage(lookup.reason),
        stages_will_reset: false,
      });
      return;
    }

    const built = await buildForProduct(lookup, erp);
    // Exactly what the client (RecipeDialog) reads per line.
    const lines = built.components.map((c) => ({
      component_product_id: c.componentProductId,
      qty_per_unit: round6(c.qtyPerUnit),
      brutto: round6(c.brutto),
    }));
    // The client only surfaces `message` when no line resolved — say why.
    const message =
      lines.length > 0
        ? undefined
        : built.notFound.length > 0
          ? notFoundMessage(built.notFound)
          : NO_USABLE_LINES_MESSAGE;

    // Would "apply" have to drop a Hamir/Krem/Bezak split? Same rule as the write.
    const plan = planRecipeRows(await readRecipeSnapshot(poolRunner, erp.id), built.components, erp.id);

    res.status(200).json({
      lines,
      not_found: built.notFound,
      ...(message !== undefined ? { message } : {}),
      poster_name: lookup.posterName,
      warnings: built.warnings,
      stages_will_reset: plan.stagesReset,
    });
  }),
);

// -----------------------------------------------------------------------------
// 4.9.3b Re-sync ONE product's recipe from Poster and unlock it —
// pm/production_manager.
// POST /api/integrations/poster/product-recipe/:erpProductId/apply
//
// A hand-saved recipe sets `recipe_locked`, after which the hourly sync skips
// the product for good. This endpoint is the explicit "take Poster's recipe
// again" action. The transaction lives in services/posterRecipeApply.ts and is
// shared with the bulk recipe-audit apply job; every rejection is a 422 that
// leaves the recipe and the lock untouched.
// -----------------------------------------------------------------------------

posterIntegrationRouter.post(
  '/product-recipe/:erpProductId/apply',
  authenticate,
  authorize('pm', 'production_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const erp = await loadErpProduct(req.params.erpProductId);
    const reader = requirePosterRecipeReader();
    const lookup = await findPosterRecipe(reader, erp);
    const result = await applyPosterRecipe(erp, lookup, {
      userId: principal.userId,
      activeLocationId: principal.activeLocationId,
    });
    res.status(200).json({
      product_id: erp.id,
      recipe_locked: false,
      source: result.source,
      poster_product_id: result.posterProductId,
      poster_name: result.posterName,
      recipe: result.recipe,
      warnings: result.warnings,
      stages_reset: result.stagesReset,
    });
  }),
);

// 4.9.3c Bulk recipe audit / apply (every product vs Poster) — see
// routes/posterRecipeAudit.ts.
posterIntegrationRouter.use('/recipe-audit', posterRecipeAuditRouter);

// -----------------------------------------------------------------------------
// 4.9.3 Status — pm reads the recent sync log.
// -----------------------------------------------------------------------------

type SyncLogRow = {
  id: number;
  entity: string;
  status: string;
  trigger: string;
  records_in: number;
  records_applied: number;
  error_detail: string | null;
  started_at: Date;
  finished_at: Date | null;
};

posterIntegrationRouter.get(
  '/status',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50) || 50));
    const { rows } = await query<SyncLogRow>(
      `SELECT id, entity, status, trigger, records_in, records_applied,
              error_detail, started_at, finished_at
         FROM poster_sync_log
        ORDER BY started_at DESC
        LIMIT $1`,
      [limit],
    );
    res.status(200).json(rows);
  }),
);
