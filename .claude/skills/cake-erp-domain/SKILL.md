---
name: cake-erp-domain
description: Domain knowledge for the ADIA ERP project — the bakery production and supply-chain model, glossary, RBAC roles, the replenishment engine, min/max logic, the request state machine, the Poster POS integration, the data model, and core invariants. Use this skill whenever working on any ERP business logic, database schema, API, or UI tied to stock, orders, production, or replenishment.
---

# ADIA ERP — Domain Knowledge

ADIA ERP is a self-correcting ERP for a bakery / confectionery production and supply chain. **One company uses it — it is NOT multi-tenant.** Authoritative sources: `docs/TZ.md` (spec) and `docs/architecture/decisions.md` (resolved decisions).

## Supply chain

```
Raw-material warehouse -> Production -> Supply depts -> Central warehouse -> Stores
   forward: goods move left -> right

Store qty<min -> Central wh check -> raw check -> Production order -> make -> ship back
   reverse: demand signal, automatic, right -> left
```

The AI dashboard layer reads over the whole chain, monitors it, and issues commands.

## Glossary (Uzbek TZ term -> code term)

| Uzbek (TZ) | Code term | Meaning |
|---|---|---|
| Mahsulotlar Ombori | raw warehouse (`location.type = raw_warehouse`) | raw materials: flour, sugar, cream |
| Ishlab chiqarish | production | turns raw -> finished / semi-finished |
| Ta'minot bo'limi | supply | depts: Tort, Perojniy, Yarim Fabrika |
| Yarim Fabrika | semi-finished | not sellable; can re-enter production as a BOM component |
| Markaziy Sklad | central warehouse (`central_warehouse`) | finished-goods hub; feeds stores |
| Do'kon | store | point of sale |
| Zayafka | `production_order` | e.g. "make 4 cakes today" |
| Ostatka | stock `qty` | current on-hand quantity |
| min / max (par level) | `min_level` / `max_level` | reorder point / fill-up level |
| Replenishment | replenishment | automatic top-up when qty <= min |
| ROP (Reorder Point) | reorder point | equals `min_level` |
| BOM (retsept) | `recipes` | 1 product = N units of component products |
| Yetkazib berishga so'rov | supply request | a shortage request needing two-step approval |

## Roles (RBAC)

Super Admin / PM (everything), Raw-warehouse manager, Production, Supply manager, Central-warehouse manager, Store manager (own store only), AI Assistant (read + approved commands, role-limited). Each user sees only their own link in the chain; PM/Admin see the whole chain. **Every location has its own assigned manager** (decision D6) — RBAC is location-scoped.

## Core algorithms

### Replenishment trigger (TZ 8.1)
For each stock row: IF `qty <= min_level` AND there is no open request for that `(product, location)` -> create `replenishment_request(qty_needed = max_level - qty)`.

### Request state machine (TZ 8.2)
```
NEW -> CHECK_STORE_SUPPLIER (central warehouse)
   - enough     -> SHIP_TO_REQUESTER -> CLOSED
   - not enough -> CHECK_PRODUCTION_INPUT (is raw material available?)
        - enough     -> CREATE_PRODUCTION_ORDER
        - not enough -> CREATE_PURCHASE_ORDER -> (on arrival) -> CREATE_PRODUCTION_ORDER
   -> PRODUCING -> DONE_TO_WAREHOUSE -> SHIP_TO_REQUESTER -> CLOSED
```
A `CREATE_PURCHASE_ORDER` step surfaces as a "supply request" requiring two-step approval (see Resolved decisions, D5).

### Dynamic min/max (sales-driven, recomputed nightly via cron — TZ 8.3)
```
avg_daily   = 7- or 30-day average sales
lead_time   = delivery days for the link
safety      = safety factor (e.g. 1.3)
review_days = replenishment review period (e.g. 2)

min_level (ROP) = avg_daily * lead_time * safety
max_level       = min_level + (avg_daily * review_days)
order_qty       = max_level - current_qty
```
Applies to **every location**, not just stores (decision D3).

## Invariants (NEVER violate)

1. Every `stock_movement` is one atomic DB transaction: source decreases, destination increases, audit log is written — all or nothing.
2. One open `replenishment_request` per `(product, location)` at a time — debounce, no duplicates.
3. Stock `qty` is never negative — DB CHECK constraint AND an application guard.
4. min/max live per `(location_id, product_id)` pair — limits differ per location.
5. Marking a production order "Tayyor" (done) decrements raw materials by the BOM and increments the central warehouse — atomically.
6. RBAC is enforced on every endpoint; a store sees only its own data. Audit-log every change (who / when / what).

## Resolved decisions (2026-05-22 — TZ 16)

Full record: `docs/architecture/decisions.md`.

- **Warehouse split (D1):** raw warehouse and central warehouse are separate physical locations.
- **Semi-finished (D2):** Yarim Fabrika has a dual flow — it ships to the central warehouse AND re-enters production as a BOM component.
- **Dynamic min/max (D3):** applies to every location, not just stores.
- **Sales & stock data source (D4):** the system integrates with **Poster POS** (account `adia`, joinposter.com) — sales are NOT entered by hand. Stock syncs from `storage.getStorageLeftovers`; sales from `dash.getTransactions` + webhooks (`transaction.close`). Poster already has 5 spots and 25 storages. ADIA ERP is the orchestration / "brain" layer on top of Poster. API ref: `docs/adia-poster-api.md`; secrets in `.env`.
- **Supply requests (D5):** a shortage creates a "Yetkazib berishga so'rov" visible to the manager; it takes effect only after BOTH the manager and the warehouse keeper approve it (two-step approval).
- **Per-location manager (D6):** every location has its own assigned manager user; RBAC is location-scoped.

## Data model (high level — full fields in `docs/TZ.md` 7)

`locations, products, recipes (BOM), stock, stock_movements, replenishment_requests, production_orders, purchase_orders, sales, sales_stats_daily, users, audit_log`. The Poster integration adds a mapping layer between Poster (spots / storages / ingredients / transactions) and ADIA entities — to be designed by `system-architect`.

## Key API endpoints (TZ 9 — all JWT + role-gated)

`GET /api/stock`, `POST /api/stock/movement`, `POST /api/sales`, `GET /api/replenishment`, `POST /api/replenishment/:id/advance`, `POST /api/production-orders`, `PATCH /api/production-orders/:id`, `GET /api/dashboard/overview`, `POST /api/assistant/query`.

## Roadmap (TZ 14)

- **Faza 1 (MVP):** locations, products, stock, movements; Poster POS sync for sales and stock leftovers; min/max + auto replenishment request + state machine; simple dashboard + Telegram notifications.
- **Faza 2:** BOM/recipes + production module (raw auto-decremented); dynamic min/max; AI assistant (read + Q&A).
- **Faza 3:** AI write-commands (with confirmation) + Telegram inline buttons; deeper Poster / analytics integration; forecasting.

## When working

- Use `spec-driven-development` before building a module; the invariants above are non-negotiable acceptance criteria.
- Any schema or logic change that could break an invariant — flag it, do not ship it.
- Verify against the TZ 15 acceptance criteria.
