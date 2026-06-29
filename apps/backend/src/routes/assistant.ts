/**
 * Assistant routes (spec §4 — F2.2 AI assistant).
 *
 *   POST /api/assistant/query             — ask a question (multi-turn, tool calls)
 *   GET  /api/assistant/sessions          — paginated list of caller's sessions
 *   GET  /api/assistant/sessions/:id      — one session + its full message list
 *
 * All endpoints are JWT-authenticated. The assistant is exposed to every role
 * (each principal carries their own RBAC scope, which the tool layer applies).
 *
 * When Vertex is disabled (no GCP creds, or NODE_ENV=test) the query endpoint
 * short-circuits with `503 VERTEX_UNAVAILABLE`. Sessions endpoints still
 * answer (they only read local rows).
 */
import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getPrincipal } from '../lib/principal.js';
import {
  asObject,
  optionalId,
  requireString,
  parseIdParam,
  parseOptionalIdParam,
} from '../lib/validate.js';
import { AppError } from '../errors/index.js';
import { isVertexEnabled } from '../integrations/vertex/client.js';
import {
  getSessionForCaller,
  listSessionsForUser,
  runAssistantQuery,
} from '../services/assistant.js';
import {
  confirmAction,
  listActionsForUser,
  rejectAction,
  type AssistantActionStatus,
} from '../services/assistantActions.js';

export const assistantRouter: Router = Router();

const ALL_ROLES = [
  'pm',
  'raw_warehouse_manager',
  'production_manager',
  'supply_manager',
  'central_warehouse_manager',
  'store_manager',
  'ai_assistant',
] as const;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// ---------------------------------------------------------------------------
// POST /api/assistant/query
// ---------------------------------------------------------------------------

assistantRouter.post(
  '/query',
  authenticate,
  authorize(...ALL_ROLES),
  asyncHandler(async (req, res) => {
    if (!isVertexEnabled()) {
      // Spec — keep the error shape, but use a custom code so the frontend
      // can render "AI yordamchi vaqtincha mavjud emas" without confusing it
      // for an auth/validation error.
      res.status(503).json({
        error: {
          code: 'VERTEX_UNAVAILABLE',
          message: 'AI yordamchi vaqtincha mavjud emas.',
        },
      });
      return;
    }

    const body = asObject(req.body);
    const message = requireString(body, 'message');
    const sessionId = optionalId(body, 'session_id');
    const principal = getPrincipal(req);

    try {
      const result = await runAssistantQuery(
        sessionId === undefined
          ? { message, principal }
          : { sessionId, message, principal },
      );
      res.status(200).json(result);
    } catch (err) {
      // The service throws `internal('VERTEX_UNAVAILABLE')` when the client
      // says it's disabled mid-request; map that to the spec 503 shape.
      if (err instanceof AppError && err.message === 'VERTEX_UNAVAILABLE') {
        res.status(503).json({
          error: {
            code: 'VERTEX_UNAVAILABLE',
            message: 'AI yordamchi vaqtincha mavjud emas.',
          },
        });
        return;
      }
      throw err;
    }
  }),
);

// ---------------------------------------------------------------------------
// GET /api/assistant/sessions
// ---------------------------------------------------------------------------

assistantRouter.get(
  '/sessions',
  authenticate,
  authorize(...ALL_ROLES),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const limitRaw = parseOptionalIdParam(
      typeof req.query.limit === 'string' ? req.query.limit : undefined,
      'limit',
    );
    const offsetRaw = req.query.offset;
    const offsetParsed =
      typeof offsetRaw === 'string' && offsetRaw !== '' ? Number(offsetRaw) : 0;
    if (!Number.isInteger(offsetParsed) || offsetParsed < 0) {
      throw AppError.validation('"offset" must be a non-negative integer.');
    }
    const limit = Math.min(limitRaw ?? DEFAULT_LIMIT, MAX_LIMIT);

    const { items, total } = await listSessionsForUser(
      principal.userId,
      limit,
      offsetParsed,
    );
    res.status(200).json({ items, total, limit, offset: offsetParsed });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/assistant/sessions/:id
// ---------------------------------------------------------------------------

assistantRouter.get(
  '/sessions/:id',
  authenticate,
  authorize(...ALL_ROLES),
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id, 'id');
    const principal = getPrincipal(req);
    const detail = await getSessionForCaller(id, principal);
    if (detail === null) {
      throw AppError.notFound('Assistant session not found.');
    }
    res.status(200).json(detail);
  }),
);

// ---------------------------------------------------------------------------
// AI write actions (Faza-3 F3.2, ADR-0009)
// ---------------------------------------------------------------------------

const ACTION_STATUSES = ['pending', 'executed', 'rejected', 'expired', 'superseded'] as const;

/**
 * POST /api/assistant/actions/:id/confirm
 *
 * Confirm a pending assistant action. Idempotent — once a row leaves
 * `pending` (executed/rejected/expired/superseded), every further confirm
 * call returns 409 ACTION_NOT_PENDING.
 *
 * Mapped status codes:
 *   * 200 — confirmed + executed; body `{ action, message_appended }`.
 *   * 403 — caller is not the owner of the action.
 *   * 404 — action id does not exist.
 *   * 409 — action is no longer pending (already executed/rejected/superseded).
 *   * 410 — action expired (5 minutes elapsed since creation).
 *   * 422 — executor's `canExecute` denied the action at confirm time
 *           (RBAC changed, or stock invariant fails).
 */
assistantRouter.post(
  '/actions/:id/confirm',
  authenticate,
  authorize(...ALL_ROLES),
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id, 'id');
    const principal = getPrincipal(req);
    const result = await confirmAction(id, principal);
    // Status / HTTP codes come from AppError directly (ACTION_NOT_PENDING
    // → 409, ACTION_EXPIRED → 410) — the global error-handler renders the
    // spec body, no explicit mapping required here.
    res.status(200).json({
      action: result.action,
      message_appended: result.appendedMessageId !== null,
    });
  }),
);

/**
 * POST /api/assistant/actions/:id/reject
 *
 * Reject a pending action. Atomic — second reject returns 409.
 */
assistantRouter.post(
  '/actions/:id/reject',
  authenticate,
  authorize(...ALL_ROLES),
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id, 'id');
    const principal = getPrincipal(req);
    const action = await rejectAction(id, principal);
    res.status(200).json({ action });
  }),
);

/**
 * GET /api/assistant/actions?session_id=&status=&limit=&offset=
 *
 * Paginated list of the caller's actions. PM does NOT see other users'
 * actions here — every row is scoped by `user_id = principal.userId`
 * (actions are personal intents, not chain-wide audit).
 */
assistantRouter.get(
  '/actions',
  authenticate,
  authorize(...ALL_ROLES),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);

    const sessionIdRaw =
      typeof req.query.session_id === 'string' ? req.query.session_id : undefined;
    const sessionId = sessionIdRaw === undefined
      ? undefined
      : parseIdParam(sessionIdRaw, 'session_id');

    let status: AssistantActionStatus | undefined;
    if (typeof req.query.status === 'string' && req.query.status !== '') {
      const s = req.query.status as AssistantActionStatus;
      if (!(ACTION_STATUSES as readonly string[]).includes(s)) {
        throw AppError.validation(
          `"status" must be one of ${ACTION_STATUSES.join(', ')}.`,
        );
      }
      status = s;
    }

    const limitRaw = parseOptionalIdParam(
      typeof req.query.limit === 'string' ? req.query.limit : undefined,
      'limit',
    );
    const offsetRaw = req.query.offset;
    const offsetParsed =
      typeof offsetRaw === 'string' && offsetRaw !== '' ? Number(offsetRaw) : 0;
    if (!Number.isInteger(offsetParsed) || offsetParsed < 0) {
      throw AppError.validation('"offset" must be a non-negative integer.');
    }
    const limit = Math.min(limitRaw ?? DEFAULT_LIMIT, MAX_LIMIT);

    // `exactOptionalPropertyTypes` — omit keys instead of passing undefined.
    const opts = {
      limit,
      offset: offsetParsed,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(status !== undefined ? { status } : {}),
    };
    const { items, total } = await listActionsForUser(principal, opts);
    res.status(200).json({ items, total, limit, offset: offsetParsed });
  }),
);
