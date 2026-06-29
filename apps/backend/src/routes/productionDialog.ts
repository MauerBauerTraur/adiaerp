/**
 * EPIC 5 / ADR-0016 §3.4 — production dialog API (web channel).
 *
 * The Telegram bot and this HTTP route are the TWO render/answer layers over
 * the channel-agnostic `productionDialog` service (Q5 — owner: web + telegram).
 *
 *   GET  /api/production/dialog?status=open
 *        → open dialogs for the caller (RBAC: own sex; pm sees all).
 *   POST /api/production/dialog/:id/answer   { option_id, qty? }
 *        → apply one answer; returns next_question | resolved + created docs.
 *   POST /api/production/dialog/:id/cancel
 *        → cancel an open dialog (sex user / pm).
 *
 * RBAC: reads are gated to `production_manager` + `pm` + `ai_assistant`; a
 * scoped manager only sees / answers dialogs whose `location_id` is one of
 * their assigned locations. Answering + cancelling are WRITE actions, so PM is
 * blocked there (read-and-recommend rule) — only the sex operator decides.
 */
import { Router } from 'express';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  getPrincipal,
  isSuperAdmin,
  requireLocationOperator,
} from '../lib/principal.js';
import { asObject, parseIdParam, requireString } from '../lib/validate.js';
import {
  answerDialog,
  cancelDialog,
  getDialog,
  listOpenDialogs,
} from '../services/productionDialog.js';

export const productionDialogRouter: Router = Router();

// GET /api/production/dialog?status=open
productionDialogRouter.get(
  '/',
  authenticate,
  authorize('pm', 'production_manager', 'ai_assistant'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const allLocations = isSuperAdmin(principal) || principal.role === 'ai_assistant';
    const sessions = await listOpenDialogs({
      assignedUserId: principal.userId,
      allLocations,
    });
    // Scoped manager: also keep dialogs that target a location they own even
    // when `assigned_user_id` was not set (a dialog can be raised by the
    // engine before an explicit assignee is known). Filter in app code so the
    // service query stays simple.
    const visible = allLocations
      ? sessions
      : sessions.filter(
          (s) =>
            s.assigned_user_id === principal.userId ||
            principal.locationIds.includes(s.location_id),
        );
    res.status(200).json({ sessions: visible });
  }),
);

// POST /api/production/dialog/:id/answer
productionDialogRouter.post(
  '/:id/answer',
  authenticate,
  authorize('pm', 'production_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const dialogId = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);
    const optionId = requireString(body, 'option_id');
    let qty: number | undefined;
    if (body.qty !== undefined && body.qty !== null) {
      const n = Number(body.qty);
      if (!Number.isFinite(n) || n <= 0) {
        throw AppError.validation('Field "qty" must be a positive number when provided.');
      }
      qty = n;
    }

    const session = await getDialog(dialogId);
    if (session === null) {
      throw AppError.notFound('Production dialog session not found.');
    }
    // Write action — PM blocked, scoped manager must own the sex location.
    await requireLocationOperator(principal, session.location_id);

    const result = await answerDialog({
      dialogId,
      optionId,
      ...(qty !== undefined ? { qty } : {}),
      actorUserId: principal.userId,
    });
    res.status(200).json({
      session: result.session,
      next_question: result.next_question,
      resolved: result.resolved,
      created_requests: result.created_requests,
    });
  }),
);

// POST /api/production/dialog/:id/cancel
productionDialogRouter.post(
  '/:id/cancel',
  authenticate,
  authorize('pm', 'production_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const dialogId = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body ?? {});
    const reason = typeof body.reason === 'string' ? body.reason : 'cancelled';

    const session = await getDialog(dialogId);
    if (session === null) {
      throw AppError.notFound('Production dialog session not found.');
    }
    await requireLocationOperator(principal, session.location_id);

    const updated = await cancelDialog({ dialogId, actorUserId: principal.userId, reason });
    res.status(200).json({ session: updated });
  }),
);
