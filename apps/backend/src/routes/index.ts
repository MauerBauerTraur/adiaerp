/**
 * API router — mounts all Phase-1 module routers under `/api`.
 *
 * Sprint 1 wired M1 (auth, locations, users), M2 (products & recipes) and
 * M3 (stock & movements). Sprint 2 adds M4 (replenishment + state machine),
 * M5 (production orders), and M6 (purchase orders). Sprint 3 adds M7
 * (Poster integration) and M8 (dashboard overview).
 *
 * Each module router applies its own `authenticate` / `authorize` middleware
 * per endpoint — there is no blanket auth on this router, because
 * `POST /api/auth/login` must stay unauthenticated.
 */
import { Router } from 'express';
import express from 'express';
import { authRouter } from './auth.js';
import { locationsRouter } from './locations.js';
import { usersRouter } from './users.js';
import { productsRouter } from './products.js';
import { stockRouter } from './stock.js';
import { replenishmentRouter } from './replenishment.js';
import { productionOrdersRouter } from './productionOrders.js';
import { productionDialogRouter } from './productionDialog.js';
import { purchaseOrdersRouter } from './purchaseOrders.js';
import { posterIntegrationRouter } from './posterIntegration.js';
import { dashboardRouter } from './dashboard.js';
import { dashboardDetailRouter } from './dashboardDetail.js';
import { adminRouter } from './admin.js';
import { assistantRouter } from './assistant.js';
import { telegramWebhookRouter } from './telegramWebhook.js';
import { forecastsRouter } from './forecasts.js';
import { salesRouter } from './sales.js';
import { nakladnoyRouter } from './nakladnoy.js';
import { cashShiftsRouter } from './cashShifts.js';
import { safeExpensesRouter } from './safeExpenses.js';
import { posterSuppliesRouter } from './posterSupplies.js';

export const apiRouter: Router = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/locations', locationsRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/products', productsRouter);
apiRouter.use('/stock', stockRouter);
apiRouter.use('/replenishment', replenishmentRouter);
apiRouter.use('/production-orders', productionOrdersRouter);
// EPIC 5 / ADR-0016 — channel-agnostic AI production dialog (web channel).
apiRouter.use('/production/dialog', productionDialogRouter);
apiRouter.use('/purchase-orders', purchaseOrdersRouter);
apiRouter.use('/dashboard', dashboardRouter);
// Dashboard MEGA Redesign Sprint C — per-stage detail drawers
// (GET /api/dashboard/{raw|production|supply|central|stores}).
apiRouter.use('/dashboard', dashboardDetailRouter);
apiRouter.use('/admin', adminRouter);
apiRouter.use('/assistant', assistantRouter);
// F3.4 / ADR-0010 — Prophet forecasts (read-only; PM scoped or per-location).
apiRouter.use('/forecasts', forecastsRouter);
// F4.6 — read-only sales window for the Stores layer page.
apiRouter.use('/sales', salesRouter);
// EPIC 8.4 — material requisition (nakladnoy) generated from a BOM demand.
apiRouter.use('/nakladnoy', nakladnoyRouter);
// EPIC 8.5 — kassa smenasi (cash shift) close-out, read-only from Poster.
apiRouter.use('/cash-shifts', cashShiftsRouter);
// EPIC 8.7 — seyf rasxodlari (safe expenses), read-only from Poster finance.
apiRouter.use('/safe-expenses', safeExpensesRouter);
// M10 — Poster Поставки (supply deliveries) sync + read.
apiRouter.use('/poster-supplies', posterSuppliesRouter);
// EPIC 4.3 (2026-05-29) — the "Yetkazib berish" / delivery module was removed.
// Departments now ship directly and the receiver accepts on arrival; there is
// no separate courier-assignment surface. The replenishment state machine
// (/api/replenishment) carries the request straight through. The old
// `assigned_to_user_id` column (migration 0015) is left in place (no
// destructive SQL); it is simply no longer exposed over HTTP.
// F3.3 / ADR-0011 — Telegram webhook (public, secret-token authed).
// Mounted before the Poster sub-router so the JSON body parser at the
// app level handles Telegram's `application/json` payloads.
apiRouter.use('/telegram', telegramWebhookRouter);
// Poster sends webhook payloads as form-encoded by default; parse them on
// this sub-tree only (JWT routes elsewhere remain JSON-only).
apiRouter.use(
  '/integrations/poster',
  express.urlencoded({ extended: true, limit: '1mb' }),
  posterIntegrationRouter,
);
