/**
 * EPIC 8.7 — GET /api/safe-expenses (seyf rasxodlari).
 *
 *   GET /api/safe-expenses?range=today|week|month|custom&from=&to=&account_id=
 *
 * Read-only window onto Poster `finance.getTransactions`, filtered to expense
 * rows and mapped to the frontend `SafeExpense` contract. The safe is a
 * company-wide money account (not store-scoped), so this is PM / admin only
 * (the owner watches it); ai_assistant may read for answering questions.
 * Poster stays read-only — nothing is written back.
 *
 * Envelope: `{ items: SafeExpense[] }`.
 */
import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { parseOptionalIdParam } from '../lib/validate.js';
import { parseDateRange, toPosterDate } from '../lib/dateRange.js';
import { listSafeExpenses } from '../services/safeExpense.js';
import { createPosterClientFromConfig } from '../integrations/poster/client.js';

export const safeExpensesRouter: Router = Router();

safeExpensesRouter.get(
  '/',
  authenticate,
  authorize('pm', 'ai_assistant'),
  asyncHandler(async (req, res) => {
    const range = parseDateRange(req.query);
    const accountId = parseOptionalIdParam(
      typeof req.query.account_id === 'string' ? req.query.account_id : undefined,
      'account_id',
    );

    const poster = createPosterClientFromConfig();
    const items = await listSafeExpenses(poster, {
      dateFrom: toPosterDate(range.from),
      dateTo: toPosterDate(new Date(range.to.getTime() - 1)),
      ...(accountId !== undefined ? { accountId } : {}),
    });
    res.status(200).json({ items });
  }),
);
