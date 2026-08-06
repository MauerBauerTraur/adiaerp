import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Loader2,
  PackageCheck,
  Pencil,
  Printer,
  Send,
  X,
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
  ProductionOrderAllocation,
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
          <Button size="sm" disabled={busyStatus !== null} onClick={() => transition('done')} className="h-7 gap-1 text-xs">
            {busyStatus === 'done' ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />}
            Tayyor
          </Button>
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
  const allocations: ProductionOrderAllocation[] = data?.allocations ?? [];

  const sebestoimost = useMemo(() => {
    function sumNodes(nodes: typeof bom): { total: number; complete: boolean } {
      let total = 0; let complete = true;
      for (const n of nodes) {
        if (n.children.length > 0) {
          const r = sumNodes(n.children);
          total += r.total;
          if (!r.complete) complete = false;
        } else {
          if (n.cost_price != null) { total += n.qty * n.cost_price; }
          else { complete = false; }
        }
      }
      return { total, complete };
    }
    return sumNodes(bom);
  }, [bom]);

  const [busyStatus, setBusyStatus] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const canAct = isPm || (order ? canActOn(order.location_id) : false);

  // ── Inline edit state ────────────────────────────────────────────────────
  const [editMode, setEditMode] = useState(false);
  const [editQty, setEditQty] = useState('');
  const [editStatus, setEditStatus] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  function enterEdit() {
    if (!order) return;
    setEditQty(String(order.qty));
    setEditStatus(order.status);
    setEditMode(true);
  }

  async function saveEdit() {
    if (!order) return;
    const newQty = Number(String(editQty).replace(',', '.'));
    if (!Number.isFinite(newQty) || newQty <= 0) {
      notify('error', "Miqdor 0 dan katta bo'lishi kerak.");
      return;
    }
    setIsSaving(true);
    const changes: string[] = [];
    try {
      // PUT for qty — only when status is still 'new'
      if (order.status === 'new' && newQty !== order.qty) {
        await apiRequest(`/api/production-orders/${order.id}`, {
          method: 'PUT',
          body: { qty: newQty },
        });
        changes.push(`Miqdor: ${order.qty} → ${newQty} ${order.product_unit ?? ''}`);
      }
      // PATCH for status
      if (editStatus !== order.status) {
        await apiRequest(`/api/production-orders/${order.id}`, {
          method: 'PATCH',
          body: { status: editStatus },
        });
        const statusLabels: Record<string, string> = {
          new: 'Yaratildi', in_progress: 'Jarayonda', done: 'Tayyor', cancelled: 'Bekor',
        };
        changes.push(`Holat: ${statusLabels[order.status] ?? order.status} → ${statusLabels[editStatus] ?? editStatus}`);
      }
      notify('success', changes.length > 0 ? changes.join(' · ') : "Oʻzgarish yoʻq.");
      setEditMode(false);
      refetchAll();
    } catch (err: unknown) {
      notify('error', err instanceof ApiError ? err.message : "Saqlashda xatolik.");
    } finally {
      setIsSaving(false);
    }
  }

  const [telegramBusy, setTelegramBusy] = useState(false);

  async function sendTelegram() {
    if (!order) return;
    setTelegramBusy(true);
    try {
      await apiRequest(`/api/production-orders/${order.id}/notify`, { method: 'POST' });
      notify('success', 'Telegram xabari yuborildi!');
    } catch (err: unknown) {
      notify('error', err instanceof ApiError ? err.message : "Telegram yuborib bo'lmadi.");
    } finally {
      setTelegramBusy(false);
    }
  }

  function printOrder() {
    if (!order) return;
    const unit = order.product_unit ?? '';

    // Flatten BOM leaf nodes (raw materials)
    type LeafRow = { name: string; qty: number; unit: string };
    function flattenLeaves(nodes: typeof bom, rows: LeafRow[] = []): LeafRow[] {
      for (const n of nodes) {
        if (n.children.length === 0) {
          rows.push({ name: n.component_name, qty: n.qty, unit: n.component_unit });
        } else {
          flattenLeaves(n.children, rows);
        }
      }
      return rows;
    }
    const leaves = flattenLeaves(bom);

    // Aggregate same-named ingredients that appear in multiple BOM branches
    const aggregated = new Map<string, LeafRow>();
    for (const l of leaves) {
      const existing = aggregated.get(l.name);
      if (existing) {
        existing.qty += l.qty;
      } else {
        aggregated.set(l.name, { ...l });
      }
    }
    const uniqueLeaves = [...aggregated.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    const rawTable =
      uniqueLeaves.length > 0
        ? `<h2 style="margin-top:20px;font-size:15px;border-bottom:1px solid #ddd;padding-bottom:6px">Xomashyolar ro'yxati</h2>
           <table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:13px">
             <thead><tr style="background:#f5f5f5">
               <th style="text-align:left;padding:6px 8px;border:1px solid #ddd">Xomashyo</th>
               <th style="text-align:right;padding:6px 8px;border:1px solid #ddd">Miqdor</th>
               <th style="text-align:right;padding:6px 8px;border:1px solid #ddd">Berildi ✓</th>
             </tr></thead>
             <tbody>${uniqueLeaves
               .map(
                 (l) =>
                   `<tr><td style="padding:6px 8px;border:1px solid #eee">${l.name}</td>
                    <td style="padding:6px 8px;border:1px solid #eee;text-align:right;font-weight:600">${l.qty.toLocaleString('uz-UZ', { maximumFractionDigits: 3 })} ${l.unit}</td>
                    <td style="padding:6px 8px;border:1px solid #eee;text-align:right;color:#aaa">□</td></tr>`,
               )
               .join('')}
             </tbody>
           </table>`
        : '';

    const win = window.open('', '_blank', 'width=750,height=900');
    if (!win) return;
    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Zayafka #${order.id}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',sans-serif;padding:30px;color:#111;font-size:14px}
  h1{font-size:20px;font-weight:700;margin-bottom:4px}
  .sub{color:#666;font-size:12px;margin-bottom:20px}
  .row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #f0f0f0}
  .label{color:#888;font-size:12px}
  .value{font-weight:600}
  .big{font-size:20px;color:#1a56db}
  .print-btn{margin-top:24px;padding:8px 20px;background:#1a56db;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px}
  @media print{.print-btn{display:none}}
</style></head><body>
<h1>Ishlab chiqarish zayafkasi</h1>
<p class="sub">ADIA ERP · Yaratilgan: ${new Date(order.created_at).toLocaleDateString('uz-UZ')}</p>
<div class="row"><span class="label">Zayafka #</span><span class="value">#${order.id}</span></div>
<div class="row"><span class="label">Mahsulot</span><span class="value">${order.product_name}</span></div>
<div class="row"><span class="label">Miqdor</span><span class="value big">${order.qty} ${unit}</span></div>
<div class="row"><span class="label">Bo'g'in (Sex)</span><span class="value">${order.location_name ?? '—'}</span></div>
${order.deadline ? `<div class="row"><span class="label">Muddat</span><span class="value">${order.deadline}</span></div>` : ''}
${order.note ? `<div class="row"><span class="label">Izoh</span><span class="value">${order.note}</span></div>` : ''}
${rawTable}
<button class="print-btn" onclick="window.print()">Chop etish / PDF saqlash</button>
</body></html>`);
    win.document.close();
    win.focus();
  }

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
        <div className="flex shrink-0 items-center gap-1">
          {canAct && isActive && (
            <Button
              variant={editMode ? 'secondary' : 'outline'}
              size="sm"
              className="gap-1.5"
              onClick={() => (editMode ? setEditMode(false) : enterEdit())}
            >
              {editMode ? <X className="size-4" /> : <Pencil className="size-4" />}
              <span className="hidden sm:inline text-xs">{editMode ? 'Yopish' : 'Tahrirlash'}</span>
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-sky-500 hover:text-sky-600"
            disabled={telegramBusy}
            onClick={() => void sendTelegram()}
            title="Telegramga yuborish"
          >
            {telegramBusy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            <span className="hidden sm:inline text-xs">Telegram</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={printOrder}
            title="Chop etish / PDF"
          >
            <Printer className="size-4" />
            <span className="hidden sm:inline text-xs">PDF</span>
          </Button>
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

            {/* Store allocations breakdown */}
            {allocations.length > 0 && (
              <div className="mt-3 border-t border-border/60 pt-3">
                <p className="mb-2 text-xs font-medium text-muted-foreground">Do'konlarga taqsimlash</p>
                <div className="space-y-1">
                  {allocations.map((a) => (
                    <div key={a.id} className="flex items-center justify-between text-sm">
                      <span className="truncate text-foreground">{a.store_location_name}</span>
                      <span className="ml-2 shrink-0 font-semibold tabular-nums text-primary">
                        {a.qty} {unit}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Inline edit panel ── */}
            {editMode && (
              <div className="mt-4 rounded-xl border border-primary/25 bg-primary/5 p-4 space-y-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tahrirlash</p>

                {/* Qty — only editable when 'new' */}
                <div className="space-y-1">
                  <label className="text-xs font-medium">Miqdor</label>
                  {order.status === 'new' ? (
                    <>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min="0.001"
                          step="any"
                          value={editQty}
                          onChange={(e) => setEditQty(e.target.value)}
                          className="w-28 rounded-lg border border-border bg-background px-3 py-1.5 text-sm tabular-nums"
                        />
                        <span className="text-xs text-muted-foreground">{order.product_unit ?? ''}</span>
                      </div>
                      {Number(editQty) !== order.qty && Number(editQty) > 0 && (
                        <p className="text-xs text-amber-600 dark:text-amber-400">
                          {order.qty} {order.product_unit ?? ''} edi → {editQty} {order.product_unit ?? ''} bo'ladi
                        </p>
                      )}
                      {Number(editQty) === order.qty && (
                        <p className="text-xs text-muted-foreground">Hozirgi: {order.qty} {order.product_unit ?? ''}</p>
                      )}
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {order.qty} {order.product_unit ?? ''}{' '}
                      <span className="text-xs">(faqat "Yaratildi" holatida tahrirlash mumkin)</span>
                    </p>
                  )}
                </div>

                {/* Status */}
                <div className="space-y-1">
                  <label className="text-xs font-medium">Holat</label>
                  <select
                    value={editStatus}
                    onChange={(e) => setEditStatus(e.target.value)}
                    className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
                  >
                    <option value={order.status}>
                      {PRODUCTION_ORDER_STATUS_LABELS[order.status] ?? order.status} (hozirgi)
                    </option>
                    {(order.status === 'new' || order.status === 'in_progress') && (
                      <option value="done">{PRODUCTION_ORDER_STATUS_LABELS['done']}</option>
                    )}
                    {(order.status === 'new' || order.status === 'in_progress') && (
                      <option value="cancelled">{PRODUCTION_ORDER_STATUS_LABELS['cancelled']}</option>
                    )}
                  </select>
                  {editStatus !== order.status && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      {PRODUCTION_ORDER_STATUS_LABELS[order.status] ?? order.status} edi →{' '}
                      {PRODUCTION_ORDER_STATUS_LABELS[editStatus as keyof typeof PRODUCTION_ORDER_STATUS_LABELS] ?? editStatus} boʻladi
                    </p>
                  )}
                </div>

                <div className="flex gap-2 pt-1">
                  <Button size="sm" disabled={isSaving} onClick={() => void saveEdit()} className="gap-1.5">
                    {isSaving && <Loader2 className="size-3.5 animate-spin" />}
                    Saqlash
                  </Button>
                  <Button variant="outline" size="sm" disabled={isSaving} onClick={() => setEditMode(false)}>
                    Bekor
                  </Button>
                </div>
              </div>
            )}

            {/* Production cost */}
            <div className="mt-3">
              {order.production_cost != null ? (
                <div className="rounded-lg bg-violet-500/8 px-3 py-2">
                  <p className="text-xs text-muted-foreground">Ishlab chiqarish xarajati</p>
                  <p className="text-base font-bold tabular-nums text-violet-700 dark:text-violet-400">
                    {(order.qty * order.production_cost).toLocaleString('uz-UZ', { maximumFractionDigits: 0 })} so'm
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {order.production_cost.toLocaleString('uz-UZ', { maximumFractionDigits: 0 })} so'm × {order.qty} {unit}
                  </p>
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/8 px-3 py-2 text-xs text-rose-700 dark:text-rose-400">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    Ishlab chiqarish narxi belgilanmagan.{' '}
                    <a
                      href="/products"
                      onClick={(e) => { e.preventDefault(); navigate('/products'); }}
                      className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:opacity-80"
                    >
                      Mahsulotlar sahifasida
                      <ExternalLink className="size-3" />
                    </a>
                    {' '}<span className="font-medium">"{order.product_name}"</span> mahsulotiga narx kiriting.
                  </span>
                </div>
              )}
            </div>

            {/* Jami xomashyo sebestoimost */}
            {sebestoimost.total > 0 && (
              <div className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2.5">
                <p className="text-xs text-muted-foreground">Jami xomashyo (Sebestoimost)</p>
                <p className="text-base font-bold tabular-nums text-amber-700 dark:text-amber-400">
                  {sebestoimost.total.toLocaleString('uz-UZ', { maximumFractionDigits: 0 })} so'm
                </p>
                {!sebestoimost.complete && (
                  <p className="text-[10px] text-muted-foreground">* Ba'zi materiallar narxi belgilanmagan</p>
                )}
              </div>
            )}

            {canAct && isActive && (
              <div className="mt-4 flex flex-wrap gap-2 border-t border-border/60 pt-4">
                <Button disabled={busyStatus !== null} onClick={() => transition('done')} className="gap-2">
                  {busyStatus === 'done' ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                  Tayyor qilish
                </Button>
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
