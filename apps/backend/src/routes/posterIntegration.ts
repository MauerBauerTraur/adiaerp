/**
 * Poster integration routes (spec section 4.9 + ADR-0002):
 *
 *   POST /api/integrations/poster/webhook[/:secret]   — no JWT; secret-token gated
 *   POST /api/integrations/poster/sync                — pm; ?entity=all|locations|products|stock|sales
 *   GET  /api/integrations/poster/status              — pm; recent poster_sync_log rows
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
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { createPosterClientFromConfig } from '../integrations/poster/client.js';
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
    const out: unknown[] = [];
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
    res.status(200).json({ results: out });
  }),
);

// -----------------------------------------------------------------------------

// 4.9.3 Fetch recipe for one product from Poster — pm/production_manager.
// GET /api/integrations/poster/product-recipe/:erpProductId
// Returns the ingredients Poster knows for this product so the user can
// review/import them into the ERP recipe without running a full sync.
// -----------------------------------------------------------------------------

function normaliseQty(structureUnit: string, ingredientUnit: string, raw: number | string): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const su = structureUnit.toLowerCase();
  const iu = ingredientUnit.toLowerCase();
  if (su === iu) return n;
  if ((su === 'g' && iu === 'kg') || (su === 'ml' && iu === 'l')) return n / 1000;
  if ((su === 'kg' && iu === 'g') || (su === 'l' && iu === 'ml')) return n * 1000;
  return n;
}


posterIntegrationRouter.get(
  '/product-recipe/:erpProductId',
  authenticate,
  authorize('pm', 'production_manager'),
  asyncHandler(async (req, res) => {
    const productId = Number(req.params.erpProductId);
    if (!Number.isInteger(productId) || productId <= 0) {
      throw AppError.validation('Invalid product id.');
    }

    // Load ERP product to find Poster IDs.
    const { rows: pRows } = await query<{
      id: number; name: string;
      poster_ingredient_id: number | null;
      poster_product_id: number | null;
    }>(
      'SELECT id, name, poster_ingredient_id, poster_product_id FROM products WHERE id = $1',
      [productId],
    );
    const erp = pRows[0];
    if (!erp) throw AppError.notFound('Product not found.');

    const cfg = loadConfig();
    if (cfg.poster.token === '') throw AppError.internal('POSTER_TOKEN not configured.');

    const client = createPosterClientFromConfig();

    // Determine if this is a prepack (poster_ingredient_id) or menu product (poster_product_id).
    type Line = { component_product_id: number; component_name: string; component_unit: string; qty_per_unit: number; brutto: number; found: boolean };
    const lines: Line[] = [];
    const notFound: string[] = [];

    async function resolveIngredient(posterId: number, ingName: string, structUnit: string, ingUnit: string, brutto: number | string, netto: number | string, batchYield: number, structureType?: string) {
      // structure_type=2 means prepack component: Poster stores the prepack's
      // product_id in ingredient_id, so look up by poster_product_id first.
      const isPrepack = String(structureType ?? '1') === '2';
      const firstQ = isPrepack
        ? 'SELECT id, name, unit::text AS unit FROM products WHERE poster_product_id = $1'
        : 'SELECT id, name, unit::text AS unit FROM products WHERE poster_ingredient_id = $1';
      const secondQ = isPrepack
        ? 'SELECT id, name, unit::text AS unit FROM products WHERE poster_ingredient_id = $1'
        : 'SELECT id, name, unit::text AS unit FROM products WHERE poster_product_id = $1';
      const r1 = await query<{ id: number; name: string; unit: string }>(firstQ, [posterId]);
      const r2 = r1.rows.length === 0
        ? await query<{ id: number; name: string; unit: string }>(secondQ, [posterId])
        : r1;
      const comp = r2.rows[0];
      const bruttoNorm = normaliseQty(structUnit, ingUnit, brutto);
      const nettoNorm = normaliseQty(structUnit, ingUnit, netto ?? brutto);
      // For "p"/pcs ingredients, Poster stores netto in grams — use brutto (pieces).
      const isPcs = ingUnit.toLowerCase() === 'p' || ingUnit.toLowerCase() === 'pcs';
      const qtyNorm = (!isPcs && nettoNorm > 0) ? nettoNorm : bruttoNorm;
      const safeYield = batchYield > 0 ? batchYield : 1;
      const perUnit = qtyNorm / safeYield;
      const bruttoPerUnit = bruttoNorm / safeYield;
      if (comp && perUnit > 0 && Number.isFinite(perUnit)) {
        lines.push({
          component_product_id: comp.id,
          component_name: comp.name,
          component_unit: comp.unit,
          qty_per_unit: Math.round(perUnit * 1e6) / 1e6,
          brutto: Math.round(bruttoPerUnit * 1e6) / 1e6,
          found: true,
        });
      } else {
        notFound.push(ingName);
      }
    }

    if (erp.poster_ingredient_id !== null) {
      // It's a prepack — fetch all prepacks and find this one.
      const prepacks = await client.getPrepacks();
      const pp = prepacks.find((p) => Number(p.ingredient_id) === erp.poster_ingredient_id);
      if (!pp) {
        res.status(200).json({ lines: [], not_found: [], message: 'Product not found in Poster prepacks.' });
        return;
      }
      const batchYield = Number(pp.out) > 0 ? Number(pp.out) / 1000 : 1;
      for (const ing of pp.ingredients ?? []) {
        const pid = Number(ing.ingredient_id);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        await resolveIngredient(pid, ing.ingredient_name, String(ing.structure_unit ?? ''), String(ing.ingredient_unit ?? ''), ing.structure_brutto, ing.structure_netto ?? ing.structure_brutto, batchYield, String(ing.structure_type ?? '1'));
      }
    } else if (erp.poster_product_id !== null) {
      // It's a menu product.
      const mp = await client.getProduct(erp.poster_product_id);
      if (!mp) {
        res.status(200).json({ lines: [], not_found: [], message: 'Product not found in Poster menu.' });
        return;
      }
      for (const ing of mp.ingredients ?? []) {
        const pid = Number(ing.ingredient_id);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        await resolveIngredient(pid, ing.ingredient_name, String(ing.structure_unit ?? ''), String(ing.ingredient_unit ?? ''), ing.structure_brutto, ing.structure_netto ?? ing.structure_brutto, 1, String(ing.structure_type ?? '1'));
      }
    } else {
      res.status(200).json({ lines: [], not_found: [], message: 'Product has no Poster link (poster_ingredient_id and poster_product_id are both null).' });
      return;
    }

    res.status(200).json({ lines, not_found: notFound });
  }),
);

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
