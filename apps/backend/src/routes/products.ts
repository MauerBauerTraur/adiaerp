/**
 * M2 — Products & Recipes / BOM (spec section 4.3).
 *
 *   GET  /api/products            — list (optional ?type=)
 *   POST /api/products            — create a product
 *   GET  /api/products/:id/recipe — the product's BOM
 *   PUT  /api/products/:id/recipe — full-replace the product's BOM
 *
 * BOM source (spec section 5.5): the Poster import path is currently blocked
 * (POSTER_TOKEN is empty — see docs/adia-poster-api.md section 8), so Phase 1
 * uses the manual `PUT .../recipe` path. The endpoint contract is unchanged
 * when import is later added.
 *
 * AC2.2 — a BOM must not create a cycle. Two layers:
 *   - direct self-reference   : product_id <> component_product_id;
 *   - deep cycle (A->B->A...)  : a recursive reachability walk before write.
 */
import { Router } from 'express';
import { query, withTransaction, type TxClient } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { writeAudit, poolRunner } from '../lib/audit.js';
import { getPrincipal } from '../lib/principal.js';
import {
  asObject,
  optionalId,
  optionalString,
  parseIdParam,
  requireEnum,
  requireNonNegativeNumber,
  requirePositiveNumber,
  requireString,
} from '../lib/validate.js';
import { matchesSearch } from '../lib/translit.js';
import {
  deriveCategory,
  effectiveType,
  type ProductCategory,
  type ProductType,
} from '../lib/productCategory.js';

export const productsRouter: Router = Router();

const PRODUCT_TYPES = ['raw', 'semi', 'finished'] as const;
const UNIT_TYPES = ['kg', 'l', 'pcs'] as const;

type ProductRow = {
  id: number;
  name: string;
  type: string;
  unit: string;
  sku: string | null;
  poster_ingredient_id: number | null;
  poster_product_id: number | null;
  is_active: boolean;
  cost_price: number | null;
  sell_price: number | null;
  batch_yield: number | null;
  production_location_id: number | null;
  storage_location_id: number | null;
  min_qty: number | null;
  max_qty: number | null;
  recipe_locked: boolean;
  total_qty: number;
  created_at: Date;
  updated_at: Date;
};

/**
 * EPIC 1.3 — a product row enriched with the smart-category fields. `category`
 * is the fine-grained semantic class; `effective_type` upgrades `Г/П`-prefixed
 * names to `finished`. The frontend prefers these over its own client-side
 * derivation.
 */
type EnrichedProductRow = ProductRow & {
  category: ProductCategory;
  effective_type: ProductType;
};

/** Attach the EPIC 1.3 smart-category fields to a product row. */
function enrich(row: ProductRow): EnrichedProductRow {
  const type = row.type as ProductType;
  return {
    ...row,
    total_qty: row.total_qty ?? 0,
    category: deriveCategory(row.name, type),
    effective_type: effectiveType(row.name, type),
  };
}

type RecipeRow = {
  id: number;
  product_id: number;
  component_product_id: number;
  qty_per_unit: number;
  brutto: number;
  stage: string | null;
  component_name: string;
  component_unit: string;
  component_cost_price: number | null;
  component_type: string;
};

/** Plain column list — used in RETURNING and simple WHERE-by-id queries. */
const PRODUCT_COLUMNS = `id, name, type, unit, sku, poster_ingredient_id,
  poster_product_id, is_active, cost_price, sell_price, batch_yield,
  production_location_id, storage_location_id, min_qty, max_qty, recipe_locked, created_at, updated_at`;

/** Full SELECT with LEFT JOIN for total_qty — used in list endpoints. */
const PRODUCT_LIST_SQL = (where?: string) =>
  `SELECT p.id, p.name, p.type, p.unit, p.sku, p.poster_ingredient_id,
          p.poster_product_id, p.is_active, p.cost_price, p.sell_price, p.batch_yield,
          p.production_location_id, p.storage_location_id, p.min_qty, p.max_qty,
          p.recipe_locked, COALESCE(s.total_qty, 0) AS total_qty, p.created_at, p.updated_at
   FROM products p
   LEFT JOIN (SELECT product_id, SUM(qty) AS total_qty FROM stock GROUP BY product_id) s
     ON s.product_id = p.id
   ${where ?? ''}
   ORDER BY p.id`;

// GET /api/products?type=
productsRouter.get(
  '/',
  authenticate,
  authorize(
    'pm',
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
  ),
  asyncHandler(async (req, res) => {
    const typeRaw = typeof req.query.type === 'string' ? req.query.type : undefined;
    if (typeRaw !== undefined && !(PRODUCT_TYPES as readonly string[]).includes(typeRaw)) {
      throw AppError.validation(`Query "type" must be one of: ${PRODUCT_TYPES.join(', ')}.`);
    }

    // EPIC 1.2 — translit-aware `?search=` over name + sku. The match is a
    // phonetic Latin↔Cyrillic normalisation (see lib/translit) that plain SQL
    // LIKE cannot express, so we apply it in application code after the `type`
    // filter narrows the candidate set in SQL.
    const searchRaw =
      typeof req.query.search === 'string' ? req.query.search.trim() : undefined;

    const { rows } =
      typeRaw === undefined
        ? await query<ProductRow>(PRODUCT_LIST_SQL())
        : await query<ProductRow>(PRODUCT_LIST_SQL('WHERE p.type = $1'), [typeRaw]);

    const filtered =
      searchRaw === undefined || searchRaw === ''
        ? rows
        : rows.filter((r) => matchesSearch(`${r.name} ${r.sku ?? ''}`, searchRaw));

    // List endpoints return a bare array (spec section 4) — no envelope.
    // Each row carries the EPIC 1.3 smart-category fields.
    res.status(200).json(filtered.map(enrich));
  }),
);

// POST /api/products  — pm, raw_warehouse_manager.
productsRouter.post(
  '/',
  authenticate,
  authorize('pm', 'raw_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);
    const name = requireString(body, 'name');
    const type = requireEnum(body, 'type', PRODUCT_TYPES);
    const unit = requireEnum(body, 'unit', UNIT_TYPES);
    const sku =
      typeof body.sku === 'string' && body.sku.trim() !== '' ? body.sku.trim() : null;
    const posterIngredientId = optionalId(body, 'poster_ingredient_id');
    const posterProductId = optionalId(body, 'poster_product_id');

    if (sku !== null) {
      const dup = await query<{ id: number }>('SELECT id FROM products WHERE sku = $1', [sku]);
      if (dup.rows.length > 0) {
        throw AppError.validation('A product with this SKU already exists.');
      }
    }

    const storageLocationId = optionalId(body, 'storage_location_id');
    const minQty =
      body.min_qty !== undefined && body.min_qty !== null
        ? requireNonNegativeNumber(body, 'min_qty')
        : null;
    const maxQty =
      body.max_qty !== undefined && body.max_qty !== null
        ? requireNonNegativeNumber(body, 'max_qty')
        : null;

    const { rows } = await query<ProductRow>(
      `INSERT INTO products (name, type, unit, sku, poster_ingredient_id, poster_product_id,
                             storage_location_id, min_qty, max_qty)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${PRODUCT_COLUMNS}`,
      [name, type, unit, sku, posterIngredientId ?? null, posterProductId ?? null,
       storageLocationId ?? null, minQty, maxQty],
    );
    const created = rows[0];
    if (created === undefined) {
      throw AppError.internal('Product insert returned no row.');
    }
    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'product.create',
      entity: 'products',
      entityId: created.id,
      payload: { name, type },
    });
    res.status(201).json({ product: enrich(created) });
  }),
);

// PATCH /api/products/bulk — bulk update production/storage location, min/max qty.
// Body: { ids: number[], production_location_id?: number|null, storage_location_id?: number|null, min_qty?: number|null, max_qty?: number|null }
productsRouter.patch(
  '/bulk',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);

    const ids = body.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      throw AppError.validation('"ids" must be a non-empty array of product IDs.');
    }
    const numIds = ids.map((id) => {
      const n = Number(id);
      if (!Number.isInteger(n) || n <= 0) throw AppError.validation(`Invalid product id: ${String(id)}`);
      return n;
    });

    const setClauses: string[] = [];
    const params: (number | null)[] = [];

    if ('production_location_id' in body) {
      params.push(body.production_location_id === null ? null : Number(body.production_location_id) || null);
      setClauses.push(`production_location_id = $${params.length}`);
    }
    if ('storage_location_id' in body) {
      params.push(body.storage_location_id === null ? null : Number(body.storage_location_id) || null);
      setClauses.push(`storage_location_id = $${params.length}`);
    }
    if ('min_qty' in body) {
      const v = body.min_qty === null ? null : Number(body.min_qty);
      if (v !== null && (!Number.isFinite(v) || v < 0)) throw AppError.validation('"min_qty" must be a non-negative number or null.');
      params.push(v);
      setClauses.push(`min_qty = $${params.length}`);
    }
    if ('max_qty' in body) {
      const v = body.max_qty === null ? null : Number(body.max_qty);
      if (v !== null && (!Number.isFinite(v) || v < 0)) throw AppError.validation('"max_qty" must be a non-negative number or null.');
      params.push(v);
      setClauses.push(`max_qty = $${params.length}`);
    }

    if (setClauses.length === 0) {
      throw AppError.validation('No valid fields to update. Provide at least one of: production_location_id, storage_location_id, min_qty, max_qty.');
    }

    params.push(numIds as unknown as number);
    const { rowCount } = await query(
      `UPDATE products SET ${setClauses.join(', ')}, updated_at = now() WHERE id = ANY($${params.length}::bigint[])`,
      params,
    );

    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'product.bulk_update',
      entity: 'products',
      entityId: 0,
      payload: { ids: numIds, fields: setClauses.map((c) => c.split(' = ')[0]), count: rowCount },
    });

    res.status(200).json({ updated: rowCount });
  }),
);

// PATCH /api/products/:id — update name / type / unit / sku.
productsRouter.patch(
  '/:id',
  authenticate,
  authorize('pm', 'raw_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const productId = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);

    const existing = await query<ProductRow>(
      `SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = $1`,
      [productId],
    );
    if (existing.rows.length === 0) {
      throw AppError.notFound('Product not found.');
    }
    const prev = existing.rows[0]!;

    const name =
      typeof body.name === 'string' ? requireString(body, 'name') : prev.name;
    const type =
      body.type !== undefined ? requireEnum(body, 'type', PRODUCT_TYPES) : (prev.type as (typeof PRODUCT_TYPES)[number]);
    const unit =
      body.unit !== undefined ? requireEnum(body, 'unit', UNIT_TYPES) : (prev.unit as (typeof UNIT_TYPES)[number]);
    const sku =
      body.sku !== undefined
        ? typeof body.sku === 'string' && body.sku.trim() !== ''
          ? body.sku.trim()
          : null
        : prev.sku;
    const productionLocationId =
      'production_location_id' in body
        ? optionalId(body, 'production_location_id')
        : prev.production_location_id;
    const storageLocationId =
      'storage_location_id' in body
        ? optionalId(body, 'storage_location_id')
        : prev.storage_location_id;
    const minQty =
      'min_qty' in body
        ? (body.min_qty === null ? null : requireNonNegativeNumber(body, 'min_qty'))
        : prev.min_qty;
    const maxQty =
      'max_qty' in body
        ? (body.max_qty === null ? null : requireNonNegativeNumber(body, 'max_qty'))
        : prev.max_qty;
    const recipeLocked =
      'recipe_locked' in body
        ? Boolean(body.recipe_locked)
        : prev.recipe_locked;

    if (sku !== null && sku !== prev.sku) {
      const dup = await query<{ id: number }>(
        'SELECT id FROM products WHERE sku = $1 AND id != $2',
        [sku, productId],
      );
      if (dup.rows.length > 0) {
        throw AppError.validation('A product with this SKU already exists.');
      }
    }

    const { rows } = await query<ProductRow>(
      `UPDATE products SET name = $1, type = $2, unit = $3, sku = $4,
              production_location_id = $5, storage_location_id = $6,
              min_qty = $7, max_qty = $8, recipe_locked = $9
       WHERE id = $10
       RETURNING ${PRODUCT_COLUMNS}`,
      [name, type, unit, sku, productionLocationId ?? null,
       storageLocationId ?? null, minQty, maxQty, recipeLocked, productId],
    );
    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'product.update',
      entity: 'products',
      entityId: productId,
      payload: { name, type, unit, sku },
    });
    res.status(200).json({ product: enrich(rows[0]!) });
  }),
);

// DELETE /api/products/:id — pm only; blocked when product has history.
productsRouter.delete(
  '/:id',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const productId = parseIdParam(req.params.id, 'id');

    const existing = await query<{ id: number }>(
      'SELECT id FROM products WHERE id = $1',
      [productId],
    );
    if (existing.rows.length === 0) {
      throw AppError.notFound('Product not found.');
    }

    const movs = await query<{ c: string }>(
      'SELECT count(*) AS c FROM stock_movements WHERE product_id = $1',
      [productId],
    );
    if (Number(movs.rows[0]?.c) > 0) {
      throw AppError.validation(
        "Harakatlar tarixi mavjud mahsulotni o'chirib bo'lmaydi.",
      );
    }

    const ords = await query<{ c: string }>(
      'SELECT count(*) AS c FROM production_orders WHERE product_id = $1',
      [productId],
    );
    if (Number(ords.rows[0]?.c) > 0) {
      throw AppError.validation(
        "Ishlab chiqarish zayavkalari mavjud mahsulotni o'chirib bo'lmaydi.",
      );
    }

    const used = await query<{ c: string }>(
      'SELECT count(*) AS c FROM recipes WHERE component_product_id = $1',
      [productId],
    );
    if (Number(used.rows[0]?.c) > 0) {
      throw AppError.validation(
        "Bu mahsulot boshqa retseptlarda komponent sifatida ishlatiladi — avval o'sha retseptlardan olib tashlang.",
      );
    }

    await query('DELETE FROM recipes WHERE product_id = $1', [productId]);
    await query('DELETE FROM stock WHERE product_id = $1', [productId]);
    await query('DELETE FROM products WHERE id = $1', [productId]);

    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'product.delete',
      entity: 'products',
      entityId: productId,
      payload: {},
    });
    res.status(204).send();
  }),
);

// GET /api/products/stock-alerts — products whose stock is below min_qty or above max_qty.
productsRouter.get(
  '/stock-alerts',
  authenticate,
  authorize(
    'pm',
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
  ),
  asyncHandler(async (_req, res) => {
    type AlertRow = {
      id: number;
      name: string;
      type: string;
      unit: string;
      min_qty: number | null;
      max_qty: number | null;
      storage_location_id: number | null;
      storage_location_name: string | null;
      current_qty: number;
      alert: 'below_min' | 'above_max';
    };
    const { rows } = await query<AlertRow>(
      `SELECT p.id, p.name, p.type::text, p.unit::text,
              p.min_qty, p.max_qty,
              p.storage_location_id, l.name AS storage_location_name,
              CASE
                WHEN p.storage_location_id IS NOT NULL
                THEN COALESCE((SELECT qty FROM stock WHERE product_id = p.id AND location_id = p.storage_location_id), 0)
                ELSE COALESCE((SELECT SUM(qty) FROM stock WHERE product_id = p.id), 0)
              END AS current_qty,
              CASE
                WHEN p.min_qty IS NOT NULL AND
                     (CASE WHEN p.storage_location_id IS NOT NULL
                           THEN COALESCE((SELECT qty FROM stock WHERE product_id = p.id AND location_id = p.storage_location_id), 0)
                           ELSE COALESCE((SELECT SUM(qty) FROM stock WHERE product_id = p.id), 0)
                      END) < p.min_qty
                THEN 'below_min'
                ELSE 'above_max'
              END AS alert
         FROM products p
         LEFT JOIN locations l ON l.id = p.storage_location_id
        WHERE p.is_active = TRUE
          AND (p.min_qty IS NOT NULL OR p.max_qty IS NOT NULL)
          AND (
            (p.min_qty IS NOT NULL AND
             (CASE WHEN p.storage_location_id IS NOT NULL
                   THEN COALESCE((SELECT qty FROM stock WHERE product_id = p.id AND location_id = p.storage_location_id), 0)
                   ELSE COALESCE((SELECT SUM(qty) FROM stock WHERE product_id = p.id), 0)
              END) < p.min_qty)
            OR
            (p.max_qty IS NOT NULL AND
             (CASE WHEN p.storage_location_id IS NOT NULL
                   THEN COALESCE((SELECT qty FROM stock WHERE product_id = p.id AND location_id = p.storage_location_id), 0)
                   ELSE COALESCE((SELECT SUM(qty) FROM stock WHERE product_id = p.id), 0)
              END) > p.max_qty)
          )
        ORDER BY p.name`,
    );
    res.status(200).json(
      rows.map((r) => ({
        ...r,
        min_qty: r.min_qty !== null ? Number(r.min_qty) : null,
        max_qty: r.max_qty !== null ? Number(r.max_qty) : null,
        current_qty: Number(r.current_qty),
      })),
    );
  }),
);

// GET /api/products/:id/used-in — products whose recipe includes :id as a component
productsRouter.get(
  '/:id/used-in',
  authenticate,
  authorize('pm', 'production_manager', 'raw_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const productId = parseIdParam(req.params.id, 'id');
    type UsedInRow = ProductRow & { qty_per_unit: number; stage: string | null };
    const { rows } = await query<UsedInRow>(
      `SELECT p.id, p.name, p.type, p.unit, p.sku,
              p.poster_ingredient_id, p.poster_product_id,
              p.is_active, p.cost_price, p.sell_price, p.batch_yield,
              p.production_location_id, 0 AS total_qty,
              p.created_at, p.updated_at,
              r.qty_per_unit, r.stage
       FROM products p
       JOIN recipes r ON r.product_id = p.id
       WHERE r.component_product_id = $1
       ORDER BY p.name, r.stage`,
      [productId],
    );
    res.status(200).json(
      rows.map((row) => ({
        ...enrich(row),
        qty_per_unit: Number(row.qty_per_unit),
        stage: row.stage ?? null,
      })),
    );
  }),
);

// GET /api/products/:id/recipe
productsRouter.get(
  '/:id/recipe',
  authenticate,
  authorize(
    'pm',
    'production_manager',
    'raw_warehouse_manager',
    'central_warehouse_manager',
    'supply_manager',
    'store_manager',
    'ai_assistant',
  ),
  asyncHandler(async (req, res) => {
    const productId = parseIdParam(req.params.id, 'id');
    const exists = await query<{ id: number }>('SELECT id FROM products WHERE id = $1', [
      productId,
    ]);
    if (exists.rows.length === 0) {
      throw AppError.notFound('Product not found.');
    }
    const { rows } = await query<RecipeRow>(
      `SELECT r.id, r.product_id, r.component_product_id, r.qty_per_unit, r.brutto,
              r.stage, p.name AS component_name, p.unit AS component_unit,
              p.cost_price AS component_cost_price, p.type AS component_type
       FROM recipes r
       JOIN products p ON p.id = r.component_product_id
       WHERE r.product_id = $1 ORDER BY r.id`,
      [productId],
    );
    res.status(200).json({
      product_id: productId,
      recipe: rows.map((r) => ({
        ...r,
        qty_per_unit: Number(r.qty_per_unit),
        brutto: Number(r.brutto),
        stage: r.stage ?? null,
      })),
    });
  }),
);

/**
 * Reject a deep BOM cycle (AC2.2). Given the proposed direct components of
 * `productId`, walk the existing recipe graph from each component: if any
 * path reaches `productId`, adding it would close a cycle.
 *
 * Runs against a `TxClient` so the BFS, the DELETE and the INSERTs all live
 * inside ONE transaction — that is the only way to keep two concurrent
 * recipe writes from racing past each other's check and closing a cycle.
 */
async function assertNoBomCycle(
  client: TxClient,
  productId: number,
  componentIds: readonly number[],
): Promise<void> {
  // Components and the product itself are the starting forbidden set.
  for (const componentId of componentIds) {
    if (componentId === productId) {
      throw AppError.validation('A product cannot be a component of itself.');
    }
  }
  // BFS over the existing recipe graph from each proposed component.
  const visited = new Set<number>();
  const queue: number[] = [...componentIds];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    if (current === productId) {
      throw AppError.validation('This BOM would create a cycle in the recipe graph.');
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    const { rows } = await client.query<{ component_product_id: number }>(
      'SELECT component_product_id FROM recipes WHERE product_id = $1',
      [current],
    );
    for (const row of rows) {
      queue.push(Number(row.component_product_id));
    }
  }
}

// PUT /api/products/:id/recipe  — full replace of the BOM.
productsRouter.put(
  '/:id/recipe',
  authenticate,
  authorize('pm', 'production_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const productId = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);

    const rawItems = body.recipe;
    if (!Array.isArray(rawItems)) {
      throw AppError.validation('Field "recipe" must be an array.');
    }

    // Validate every line and collect (component_product_id, qty_per_unit, brutto, stage).
    const VALID_STAGES = ['dough', 'cream', 'decoration', 'other'] as const;
    const items: { componentId: number; qtyPerUnit: number; brutto: number; stage: string }[] = [];
    const seen = new Set<number>();
    for (const raw of rawItems) {
      const line = asObject(raw);
      const componentId = optionalId(line, 'component_product_id');
      if (componentId === undefined) {
        throw AppError.validation('Each recipe line needs a "component_product_id".');
      }
      const qtyPerUnit = requirePositiveNumber(line, 'qty_per_unit');
      const brutto = requireNonNegativeNumber(line, 'brutto');
      const stageRaw = optionalString(line, 'stage') ?? 'other';
      const stage = (VALID_STAGES as readonly string[]).includes(stageRaw) ? stageRaw : 'other';
      if (componentId === productId) {
        throw AppError.validation('A product cannot be a component of itself.');
      }
      if (seen.has(componentId)) {
        throw AppError.validation(`Duplicate component_product_id ${componentId} in recipe.`);
      }
      seen.add(componentId);
      items.push({ componentId, qtyPerUnit, brutto, stage });
    }

    // The product and all components must exist.
    const product = await query<{ id: number }>('SELECT id FROM products WHERE id = $1', [
      productId,
    ]);
    if (product.rows.length === 0) {
      throw AppError.notFound('Product not found.');
    }
    if (items.length > 0) {
      const ids = items.map((it) => it.componentId);
      const found = await query<{ id: number }>(
        'SELECT id FROM products WHERE id = ANY($1::bigint[])',
        [ids],
      );
      if (found.rows.length !== ids.length) {
        throw AppError.validation('One or more component_product_id values do not exist.');
      }
    }

    // Full replace inside one transaction: cycle check + delete old lines +
    // insert new + audit. AC2.2 — running the cycle BFS on the same client
    // as the writes is the only way to keep two concurrent recipe writes
    // from racing past each other's check and closing a cycle.
    const inserted = await withTransaction(async (tx) => {
      await assertNoBomCycle(
        tx,
        productId,
        items.map((it) => it.componentId),
      );
      await tx.query('DELETE FROM recipes WHERE product_id = $1', [productId]);
      const out: RecipeRow[] = [];
      for (const it of items) {
        const { rows } = await tx.query<RecipeRow>(
          `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, brutto, stage)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, product_id, component_product_id, qty_per_unit, brutto, stage`,
          [productId, it.componentId, it.qtyPerUnit, it.brutto, it.stage],
        );
        const row = rows[0];
        if (row !== undefined) {
          out.push(row);
        }
      }
      await tx.query('UPDATE products SET recipe_locked = TRUE WHERE id = $1', [productId]);
      await writeAudit(tx, {
        actorUserId: principal.userId,
        action: 'product.recipe.replace',
        entity: 'recipes',
        entityId: productId,
        payload: { component_count: items.length },
      });
      return out;
    });

    res.status(200).json({ product_id: productId, recipe: inserted });
  }),
);
