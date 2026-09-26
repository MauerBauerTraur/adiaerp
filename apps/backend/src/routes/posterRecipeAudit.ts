/**
 * Bulk Poster recipe audit / apply / restore (mounted at
 * /api/integrations/poster/recipe-audit):
 *
 *   GET  /         — pm, production_manager: { job, report, last_apply_report,
 *                    restorable_job_id }.
 *   GET  /job      — pm, production_manager: { job } (cheap, for polling).
 *   POST /run      — pm, production_manager: start a dry-run audit (read-only,
 *                    no advisory lock).
 *                    202 { job }; 200 { job } with the RUNNING job when one runs.
 *   POST /apply    — pm only. Body { product_ids: number[] (required, non-empty),
 *                    include_stage_resets?: boolean }. Only ids that are still
 *                    targets in a fresh pre-audit ('differs', or 'match' +
 *                    locked) are applied; the rest are skipped with a reason.
 *                    202 { job }.
 *   POST /restore  — pm only. Body { job_id: string, product_ids?: number[] }:
 *                    put back what that apply job replaced. 202 { job };
 *                    404 when the job left no snapshot.
 *
 * 409 when another recipe job is running (apply/restore) or when the hourly
 * Poster recipe sync holds the shared lock (run/apply/restore); 422 bad body.
 */
import { Router } from 'express';
import { AppError } from '../errors/index.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getPrincipal } from '../lib/principal.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { RECIPE_LOCK_BUSY_MESSAGE } from '../integrations/poster/recipeLock.js';
import { requirePosterRecipeReader } from '../services/posterRecipeApply.js';
import {
  getRecipeAuditJob,
  getRecipeAuditState,
  loadBulkSnapshot,
  startRecipeApply,
  startRecipeAudit,
  startRecipeRestore,
  type StartOutcome,
} from '../services/posterRecipeAudit.js';

export const posterRecipeAuditRouter: Router = Router();

const SYNC_BUSY = RECIPE_LOCK_BUSY_MESSAGE;
const JOB_BUSY = "Boshqa retsept tekshiruvi yoki yangilash jarayoni hali ishlayapti — tugashini kuting.";

/** Map a start attempt of a WRITE job (apply/restore) to the HTTP answer. */
function startedOrConflict(outcome: StartOutcome): StartOutcome & { outcome: 'started' } {
  if (outcome.outcome === 'sync_busy') throw AppError.conflict(SYNC_BUSY);
  if (outcome.outcome === 'running') throw AppError.conflict(JOB_BUSY);
  return outcome as StartOutcome & { outcome: 'started' };
}

function body(req: { body?: unknown }): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>) : {};
}

/** A non-empty list of positive integers (deduplicated), or 422. */
function parseIds(raw: unknown, field: string): number[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw AppError.validation(`"${field}" bo'sh bo'lmagan mahsulot ID ro'yxati bo'lishi kerak.`);
  }
  const ids = raw.map((v) => (typeof v === 'number' || typeof v === 'string' ? Number(v) : Number.NaN));
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw AppError.validation(`"${field}" faqat musbat butun sonlardan iborat bo'lishi kerak.`);
  }
  return [...new Set(ids)];
}

posterRecipeAuditRouter.get(
  '/',
  authenticate,
  authorize('pm', 'production_manager'),
  asyncHandler(async (_req, res) => {
    res.status(200).json(await getRecipeAuditState());
  }),
);

posterRecipeAuditRouter.get(
  '/job',
  authenticate,
  authorize('pm', 'production_manager'),
  (_req, res) => {
    res.status(200).json(getRecipeAuditJob());
  },
);

posterRecipeAuditRouter.post(
  '/run',
  authenticate,
  authorize('pm', 'production_manager'),
  asyncHandler(async (_req, res) => {
    const outcome = await startRecipeAudit(requirePosterRecipeReader());
    if (outcome.outcome === 'sync_busy') throw AppError.conflict(SYNC_BUSY);
    res.status(outcome.outcome === 'started' ? 202 : 200).json({ job: outcome.job });
  }),
);

posterRecipeAuditRouter.post(
  '/apply',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const b = body(req);
    const productIds = parseIds(b.product_ids, 'product_ids');
    const include = b.include_stage_resets;
    if (include !== undefined && typeof include !== 'boolean') {
      throw AppError.validation('"include_stage_resets" true yoki false bo\'lishi kerak.');
    }
    const reader = requirePosterRecipeReader();
    const { job } = startedOrConflict(
      await startRecipeApply(
        reader,
        { productIds, includeStageResets: include === true },
        { userId: principal.userId, activeLocationId: principal.activeLocationId },
      ),
    );
    res.status(202).json({ job });
  }),
);

posterRecipeAuditRouter.post(
  '/restore',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const b = body(req);
    const jobId = typeof b.job_id === 'string' ? b.job_id.trim() : '';
    if (jobId === '') throw AppError.validation('"job_id" majburiy.');
    const productIds = b.product_ids === undefined ? undefined : parseIds(b.product_ids, 'product_ids');
    if ((await loadBulkSnapshot(jobId)) === null) {
      throw AppError.notFound('Bu yangilash uchun tiklash nuqtasi (snapshot) topilmadi.');
    }
    const reader = requirePosterRecipeReader();
    const { job } = startedOrConflict(
      await startRecipeRestore(
        reader,
        { jobId, ...(productIds !== undefined ? { productIds } : {}) },
        { userId: principal.userId, activeLocationId: principal.activeLocationId },
      ),
    );
    res.status(202).json({ job });
  }),
);
