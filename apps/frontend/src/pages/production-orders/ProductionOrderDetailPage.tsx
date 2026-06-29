import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  PackageCheck,
  PlayCircle,
  Send,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { ErrorState, LoadingState } from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { useCanAct } from '@/hooks/useCanAct';
import { apiRequest, ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import {
  PRODUCTION_ORDER_STATUS_LABELS,
  PRODUCTION_ORDER_STATUS_VARIANT,
} from '@/lib/labels';
import type {
  ProductionDispatch,
  ProductionOrder,
  ProductionOrderBomResponse,
} from '@/lib/types';
import {
  BomTreeNode,
  collectExpandableKeys,
  fmtQty,
  TYPE_CHIP,
  TYPE_LABELS,
} from './BomTree';

// ---------------------------------------------------------------------------
// Batch API helpers
// ---------------------------------------------------------------------------
async function apiBatchDispatch(ids: number[]): Promise<number> {
  const r = await apiRequest<{ dispatched: number }>(
    '/api/production-orders/dispatches/batch-dispatch',
    { method: 'PATCH', body: { ids } },
  );
  return r.dispatched;
}

async function apiBatchReceive(ids: number[]): Promise<number> {
  const r = await apiRequest<{ received: number }>(
    '/api/production-orders/dispatches/batch-receive',
    { method: 'PATCH', body: { ids } },
  );
  return r.received;
}

// ---------------------------------------------------------------------------
// Sub-order inline detail — NO dispatch section (see own detail page)
// ---------------------------------------------------------------------------
function SubOrderDetail({
  sub,
  onTransitioned,
}: {
  sub: ProductionOrder & { product_unit?: string };
  onTransitioned: () => void;
}) {
  const { notify } = useToast();
  const { user } = useAuth();
  const { canActOn } = useCanAct();
  const isPm = user?.role === 'pm' || user?.role === 'super_admin';

  const { data, isLoading } = useApiQuery<ProductionOrderBomResponse>(
    `/api/production-orders/${sub.id}/bom`,
  );

  const bom = data?.bom ?? [];

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!data) return;
    const keys = new Set<string>();
    collectExpandableKeys(data.bom, 0, keys);
    setExpanded(keys);
  }, [data]);

  const [busyStatus, setBusyStatus] = useState<string | null>(null);
  const canAct = isPm || canActOn(sub.location_id);

  async function transition(nextStatus: 'in_progress' | 'done' | 'cancelled') {
    setBusyStatus(nextStatus);
    try {
      await apiRequest(`/api/production-orders/${sub.id}`, {
        method: 'PATCH',
        body: { status: nextStatus },
      });
      notify('success', `#${sub.id} holati: ${PRODUCTION_ORDER_STATUS_LABELS[nextStatus]}.`);
      onTransitioned();
    } catch (err: unknown) {
      notify('error', err instanceof ApiError ? err.message : "Amalni bajarib bo'lmadi.");
    } finally {
      setBusyStatus(null);
    }
  }

  function toggleNode(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const unit = sub.product_unit ?? '';
  const isActive = sub.status === 'new' || sub.status === 'in_progress';

  return (
    <div className="rounded-lg border border-border/60 bg-card/30">
      <div className="flex items-start justify-between gap-3 border-b border-border/40 p-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            #{sub.id} · {sub.stage_role === 'zagatovka' ? 'Zagatovka' : 'Quyi zayavka'}
          </p>
          <p className="text-sm font-semibold">{sub.product_name}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            <span className="font-medium tabular-nums">{sub.qty} {unit}</span>
            {sub.location_name ? ` · ${sub.location_name}` : ''}
          </p>
        </div>
        <Badge variant={PRODUCTION_ORDER_STATUS_VARIANT[sub.status]} className="shrink-0 text-xs">
          {PRODUCTION_ORDER_STATUS_LABELS[sub.status]}
        </Badge>
      </div>

      {canAct && isActive && (
        <div className="flex flex-wrap gap-1.5 border-b border-border/40 px-3 py-2">
          {sub.status === 'new' && (
            <Button size="sm" disabled={busyStatus !== null} onClick={() => transition('in_progress')} className="h-7 gap-1 text-xs">
              {busyStatus === 'in_progress' ? <Loader2 className="size-3 animate-spin" /> : <PlayCircle className="size-3" />}
              Boshlash
            </Button>
          )}
          {sub.status === 'in_progress' && (
            <Button size="sm" disabled={busyStatus !== null} onClick={() => transition('done')} className="h-7 gap-1 text-xs">
              {busyStatus === 'done' ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />}
              Topshirish
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={busyStatus !== null} onClick={() => transition('cancelled')}
            className="h-7 gap-1 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive">
            {busyStatus === 'cancelled' ? <Loader2 className="size-3 animate-spin" /> : <XCircle className="size-3" />}
            Bekor
          </Button>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Yuklanmoqda…
        </div>
      ) : bom.length > 0 ? (
        <div className="p-2">
          {bom.map((node) => (
            <BomTreeNode key={`0-${node.component_product_id}`} node={node} depth={0} expanded={expanded} onToggle={toggleNode} />
          ))}
        </div>
      ) : (
        <p className="px-3 py-2 text-xs text-muted-foreground">Retsept topilmadi.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Zarur materiallar — dispatch table with berildi/qabul + bulk actions
// ---------------------------------------------------------------------------
function ZarurMateriallar({
  dispatchItems,
  bom,
  userRole,
  canAct,
  qty,
  unit,
  mainOrderId,
  mainProductId,
  subOrders,
  onChanged,
}: {
  dispatchItems: ProductionDispatch[];
  bom: ProductionOrderBomResponse['bom'];
  userRole: string | undefined;
  canAct: boolean;
  qty: number;
  unit: string;
  mainOrderId: number;
  mainProductId: number;
  subOrders: (ProductionOrder & { product_unit?: string })[];
  onChanged: () => void;
}) {
  const { notify } = useToast();
  const [busy, setBusy] = useState<number | null>(null);
  const [busyBulkDispatch, setBusyBulkDispatch] = useState(false);
  const [busyBulkReceive, setBusyBulkReceive] = useState(false);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!bom.length) return;
    const keys = new Set<string>();
    collectExpandableKeys(bom, 0, keys);
    setExpanded(keys);
  }, [bom]);

  const isWarehouse =
    userRole === 'raw_warehouse_manager' || userRole === 'pm' || userRole === 'super_admin';
  const isProdManager =
    userRole === 'production_manager' || userRole === 'pm' || userRole === 'super_admin';
  const isCentralWarehouse =
    userRole === 'central_warehouse_manager' || userRole === 'pm' || userRole === 'super_admin';

  // Split: finished product OUTPUT dispatch vs raw/semi material INPUT dispatches.
  // The finished product dispatch has the same product_id as the production order itself.
  const finishedDispatches = dispatchItems.filter(
    (i) => i.product_id === mainProductId && i.production_order_id === mainOrderId,
  );
  const materialItems = dispatchItems.filter(
    (i) => !(i.product_id === mainProductId && i.production_order_id === mainOrderId),
  );

  const pendingIds = materialItems.filter((i) => i.status === 'pending').map((i) => i.id);
  const dispatchedIds = materialItems.filter((i) => i.status === 'dispatched').map((i) => i.id);

  async function markDispatched(id: number) {
    setBusy(id);
    try {
      await apiRequest(`/api/production-orders/dispatches/${id}/dispatch`, { method: 'PATCH' });
      notify('success', 'Berildi deb belgilandi.');
      onChanged();
    } catch (err: unknown) {
      notify('error', err instanceof ApiError ? err.message : 'Amal bajarilmadi.');
    } finally {
      setBusy(null);
    }
  }

  async function markReceived(id: number) {
    setBusy(id);
    try {
      await apiRequest(`/api/production-orders/dispatches/${id}/receive`, { method: 'PATCH' });
      notify('success', 'Qabul qilindi.');
      onChanged();
    } catch (err: unknown) {
      notify('error', err instanceof ApiError ? err.message : 'Amal bajarilmadi.');
    } finally {
      setBusy(null);
    }
  }

  async function bulkDispatch() {
    if (!pendingIds.length) return;
    setBusyBulkDispatch(true);
    try {
      const n = await apiBatchDispatch(pendingIds);
      notify('success', `${n} ta material "berildi" deb belgilandi.`);
      onChanged();
    } catch (err: unknown) {
      notify('error', err instanceof ApiError ? err.message : 'Amal bajarilmadi.');
    } finally {
      setBusyBulkDispatch(false);
    }
  }

  async function bulkReceive() {
    if (!dispatchedIds.length) return;
    setBusyBulkReceive(true);
    try {
      const n = await apiBatchReceive(dispatchedIds);
      notify('success', `${n} ta material qabul qilindi. Ombordan ayrildi.`);
      onChanged();
    } catch (err: unknown) {
      notify('error', err instanceof ApiError ? err.message : 'Amal bajarilmadi.');
    } finally {
      setBusyBulkReceive(false);
    }
  }

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">

      {/* === Tayyor mahsulot (OUTPUT) — sexdan omborga === */}
      {finishedDispatches.length > 0 && (
        <div className="shrink-0">
          <div className="mb-1.5 flex items-center gap-2">
            <h2 className="text-sm font-semibold">Tayyor mahsulot</h2>
            <span className="text-xs text-muted-foreground">Sexdan omborga jo'natish</span>
          </div>
          <Card className="overflow-hidden">
            <table className="w-full text-xs">
              <tbody className="divide-y divide-border/40">
                {finishedDispatches.map((item) => (
                  <tr key={item.id} className={`hover:bg-muted/20 ${item.status === 'received' ? 'opacity-60' : ''}`}>
                    <td className="py-2 pl-3 pr-2 font-semibold">{item.product_name}</td>
                    <td className="py-2 px-2 text-right tabular-nums font-bold text-emerald-600 dark:text-emerald-400">
                      {fmtQty(item.qty_needed, item.product_unit)}
                    </td>
                    <td className="py-2 px-2 text-center">
                      {item.status === 'pending' && (
                        <span className="inline-flex rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                          Kutilmoqda
                        </span>
                      )}
                      {item.status === 'dispatched' && (
                        <span className="inline-flex rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-400">
                          Jo'natildi
                        </span>
                      )}
                      {item.status === 'received' && (
                        <span className="inline-flex rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                          Qabul qilindi
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pl-2 pr-3 text-right">
                      {item.status === 'pending' && isProdManager && (
                        <Button size="sm" variant="outline" disabled={busy === item.id} onClick={() => markDispatched(item.id)} className="h-6 gap-1 px-2 text-[10px]">
                          {busy === item.id ? <Loader2 className="size-2.5 animate-spin" /> : <Send className="size-2.5" />}
                          Jo'natish
                        </Button>
                      )}
                      {item.status === 'dispatched' && isCentralWarehouse && (
                        <Button size="sm" variant="outline" disabled={busy === item.id} onClick={() => markReceived(item.id)} className="h-6 gap-1 px-2 text-[10px]">
                          {busy === item.id ? <Loader2 className="size-2.5 animate-spin" /> : <PackageCheck className="size-2.5" />}
                          Qabul
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}

      {/* === Zarur materiallar (INPUT) — ombordan sexga === */}
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">
            Zarur materiallar
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              {qty} {unit} uchun
            </span>
          </h2>
          <div className="flex items-center gap-2">
            {isWarehouse && canAct && pendingIds.length > 0 && (
              <Button size="sm" variant="outline" disabled={busyBulkDispatch} onClick={bulkDispatch} className="gap-1.5">
                {busyBulkDispatch ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                Hammasi berildi ({pendingIds.length})
              </Button>
            )}
            {isProdManager && canAct && dispatchedIds.length > 0 && (
              <Button size="sm" variant="outline" disabled={busyBulkReceive} onClick={bulkReceive} className="gap-1.5">
                {busyBulkReceive ? <Loader2 className="size-3.5 animate-spin" /> : <PackageCheck className="size-3.5" />}
                Hammasi qabul ({dispatchedIds.length})
              </Button>
            )}
          </div>
        </div>

        <Card className="overflow-hidden">
          {materialItems.length > 0 ? (
            <table className="w-full text-xs">
              <thead className="border-b border-border/60 bg-muted/30">
                <tr>
                  <th className="py-2 pl-3 pr-2 text-left font-medium text-muted-foreground">Mahsulot</th>
                  <th className="hidden py-2 px-2 text-left font-medium text-muted-foreground sm:table-cell">Zayavka</th>
                  <th className="py-2 px-2 text-right font-medium text-muted-foreground">Miqdor</th>
                  <th className="py-2 px-2 text-center font-medium text-muted-foreground">Holat</th>
                  <th className="py-2 pl-2 pr-3 text-right font-medium text-muted-foreground">Amal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {materialItems.map((item) => {
                  const isMainOrder = item.production_order_id === mainOrderId;
                  const sub = isMainOrder ? null : subOrders.find((s) => s.id === item.production_order_id);
                  return (
                    <tr key={item.id} className={`hover:bg-muted/20 ${item.status === 'received' ? 'opacity-60' : ''}`}>
                      <td className="py-2 pl-3 pr-2 font-medium">{item.product_name}</td>
                      <td className="hidden py-2 px-2 sm:table-cell">
                        {isMainOrder ? (
                          <span className="inline-flex rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-400">
                            Asosiy
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                            Zagatovka
                            {sub && <span className="opacity-70">#{sub.id}</span>}
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {fmtQty(item.qty_needed, item.product_unit)}
                      </td>
                      <td className="py-2 px-2 text-center">
                        {item.status === 'pending' && (
                          <span className="inline-flex rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                            Kutilmoqda
                          </span>
                        )}
                        {item.status === 'dispatched' && (
                          <span className="inline-flex rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-400">
                            Berildi
                          </span>
                        )}
                        {item.status === 'received' && (
                          <span className="inline-flex rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                            Qabul qilindi
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 pl-2 pr-3 text-right">
                        {item.status === 'pending' && canAct && isWarehouse && (
                          <Button size="sm" variant="outline" disabled={busy === item.id} onClick={() => markDispatched(item.id)} className="h-6 gap-1 px-2 text-[10px]">
                            {busy === item.id ? <Loader2 className="size-2.5 animate-spin" /> : <Send className="size-2.5" />}
                            Berildi
                          </Button>
                        )}
                        {item.status === 'dispatched' && canAct && isProdManager && (
                          <Button size="sm" variant="outline" disabled={busy === item.id} onClick={() => markReceived(item.id)} className="h-6 gap-1 px-2 text-[10px]">
                            {busy === item.id ? <Loader2 className="size-2.5 animate-spin" /> : <PackageCheck className="size-2.5" />}
                            Qabul
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : bom.length > 0 ? (
            /* Fallback: BOM-derived flat list — no dispatch records yet */
            <div>
              <div className="border-b border-border/40 bg-amber-50/50 px-3 py-2 dark:bg-amber-950/20">
                <p className="text-[11px] text-amber-700 dark:text-amber-400">
                  Dispatch yozuvlari topilmadi. Quyida retseptdan kerakli materiallar ko'rsatilgan.
                </p>
              </div>
              <div className="p-2">
                {bom.map((node) => (
                  <BomTreeNode key={`0-${node.component_product_id}`} node={node} depth={0} expanded={expanded} onToggle={toggleExpanded} />
                ))}
              </div>
            </div>
          ) : (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              Retsept kiritilmagan yoki xomashyo talab qilinmaydi.
            </p>
          )}
        </Card>

        {/* BOM recipe tree — always visible when bom exists and there are dispatch records */}
        {bom.length > 0 && materialItems.length > 0 && (
          <div className="shrink-0">
            <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">Retsept tarkibi</h3>
            <Card className="overflow-hidden p-2">
              <div className="mb-2 flex flex-wrap gap-1.5 border-b border-border/40 px-1 pb-2">
                {(['raw', 'semi', 'finished'] as const).map((t) => (
                  <span key={t} className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${TYPE_CHIP[t]}`}>
                    {TYPE_LABELS[t]}
                  </span>
                ))}
              </div>
              {bom.map((node) => (
                <BomTreeNode key={`bom-${node.component_product_id}`} node={node} depth={0} expanded={expanded} onToggle={toggleExpanded} />
              ))}
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page — two-column fixed layout, no page-level scroll
// ---------------------------------------------------------------------------
export function ProductionOrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { notify } = useToast();
  const { user } = useAuth();
  const { canActOn } = useCanAct();
  const isPm = user?.role === 'pm' || user?.role === 'super_admin';

  const { data, isLoading, error, refetch } =
    useApiQuery<ProductionOrderBomResponse>(
      id ? `/api/production-orders/${id}/bom` : null,
    );

  const { data: dispatchItems, refetch: refetchDispatches } =
    useApiQuery<ProductionDispatch[]>(
      id ? `/api/production-orders/${id}/dispatches` : null,
    );

  function refetchAll() {
    refetch();
    refetchDispatches();
  }

  const order = data?.order;
  const bom = data?.bom ?? [];
  const subOrders = data?.sub_orders ?? [];

  const [busyStatus, setBusyStatus] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const canAct = isPm || (order ? canActOn(order.location_id) : false);

  async function transition(nextStatus: 'in_progress' | 'done' | 'cancelled') {
    if (!order) return;
    setActionError(null);
    setBusyStatus(nextStatus);
    try {
      await apiRequest(`/api/production-orders/${order.id}`, {
        method: 'PATCH',
        body: { status: nextStatus },
      });
      notify('success', `Holat yangilandi: ${PRODUCTION_ORDER_STATUS_LABELS[nextStatus]}.`);
      refetchAll();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === 'INSUFFICIENT_STOCK') {
        setActionError("BOM komponentlari yetarli emas — zayavka yakunlanmadi. Avval xom-ashyoni to'ldiring.");
      } else {
        setActionError(err instanceof ApiError ? err.message : "Amalni bajarib bo'lmadi.");
      }
    } finally {
      setBusyStatus(null);
    }
  }

  if (isLoading) return <LoadingState />;
  if (error || !order)
    return <ErrorState message={error ?? 'Zayavka topilmadi.'} onRetry={refetch} />;

  const unit = order.product_unit ?? '';
  const isActive = order.status === 'new' || order.status === 'in_progress';

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col gap-3">

      {/* ── Top bar ── */}
      <div className="flex shrink-0 items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          <span className="hidden sm:inline">Orqaga</span>
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 text-xs text-muted-foreground">#{order.id}</span>
          <h1 className="truncate text-lg font-bold">{order.product_name}</h1>
          <Badge variant={PRODUCTION_ORDER_STATUS_VARIANT[order.status]} className="shrink-0">
            {PRODUCTION_ORDER_STATUS_LABELS[order.status]}
          </Badge>
        </div>
      </div>

      {/* ── Two-column body ── */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[2fr_3fr]">

        {/* LEFT: order info + actions + sub-orders ──────────────────────── */}
        <div className="flex flex-col gap-3 overflow-y-auto pr-0.5">

          <Card className="shrink-0 p-4">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Miqdor</dt>
                <dd className="text-base font-bold tabular-nums">{order.qty} {unit}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Muddat</dt>
                <dd className="font-medium">{order.deadline ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Bo'g'in</dt>
                <dd className="font-medium">{order.location_name ?? '—'}</dd>
              </div>
              {order.target_location_name && (
                <div>
                  <dt className="text-xs text-muted-foreground">Maqsad sklad</dt>
                  <dd className="font-medium">{order.target_location_name}</dd>
                </div>
              )}
              <div className="col-span-2">
                <dt className="text-xs text-muted-foreground">Yaratilgan</dt>
                <dd className="text-xs text-muted-foreground">{formatDateTime(order.created_at)}</dd>
              </div>
              {order.note && (
                <div className="col-span-2">
                  <dt className="text-xs text-muted-foreground">Izoh</dt>
                  <dd className="text-xs italic text-muted-foreground">{order.note}</dd>
                </div>
              )}
            </dl>

            {canAct && isActive && (
              <div className="mt-4 flex flex-wrap gap-2 border-t border-border/60 pt-4">
                {order.status === 'new' && (
                  <Button disabled={busyStatus !== null} onClick={() => transition('in_progress')} className="gap-2">
                    {busyStatus === 'in_progress' ? <Loader2 className="size-4 animate-spin" /> : <PlayCircle className="size-4" />}
                    Boshlash
                  </Button>
                )}
                {order.status === 'in_progress' && (
                  <Button disabled={busyStatus !== null} onClick={() => transition('done')} className="gap-2">
                    {busyStatus === 'done' ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                    Topshirish
                  </Button>
                )}
                <Button variant="outline" disabled={busyStatus !== null} onClick={() => transition('cancelled')}
                  className="gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive">
                  {busyStatus === 'cancelled' ? <Loader2 className="size-4 animate-spin" /> : <XCircle className="size-4" />}
                  Bekor qilish
                </Button>
              </div>
            )}

            {actionError && (
              <p className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {actionError}
              </p>
            )}
          </Card>

          {subOrders.length > 0 && (
            <section className="flex min-h-0 flex-col gap-2">
              <h2 className="shrink-0 text-sm font-semibold">
                Quyi zayavkalar
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">({subOrders.length} ta)</span>
              </h2>
              <div className="space-y-2">
                {subOrders.map((sub) => (
                  <SubOrderDetail key={sub.id} sub={sub} onTransitioned={refetch} />
                ))}
              </div>
            </section>
          )}
        </div>

        {/* RIGHT: unified Zarur materiallar ──────────────────────────────── */}
        <div className="flex min-h-0 flex-col overflow-y-auto pr-0.5">
          <ZarurMateriallar
            dispatchItems={dispatchItems ?? []}
            bom={bom}
            userRole={user?.role}
            canAct={canAct}
            qty={order.qty}
            unit={unit}
            mainOrderId={order.id}
            mainProductId={order.product_id}
            subOrders={subOrders}
            onChanged={refetchAll}
          />
        </div>
      </div>
    </div>
  );
}
