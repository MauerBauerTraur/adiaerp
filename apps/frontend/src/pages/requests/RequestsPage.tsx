import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { MobileCardList } from '@/components/ui/table-mobile';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { useCanAct } from '@/hooks/useCanAct';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { ApiError, apiRequest } from '@/lib/api-client';
import { formatDateTime, formatQty } from '@/lib/format';
import {
  REPLENISHMENT_STATUS_LABELS,
  REPLENISHMENT_STATUS_VARIANT,
} from '@/lib/labels';
import { describeStatus } from '@/pages/dashboard/executive/requestTracer';
import type { ReplenishmentRequest } from '@/lib/types';
import { TERMINAL_REPLENISHMENT_STATUSES } from '@/lib/types';
import {
  RequestActionDialog,
  type RequestActionMode,
  type RequestActionPayload,
} from './RequestActionDialog';

/**
 * F4.14 — unified replenishment inbox.
 *
 * Three tabs scope the same `/api/replenishment` list against the
 * signed-in user's role / locations:
 *
 *   1. "Menga keluvchi"   — open requests TARGETED at one of the user's
 *                            bo'g'inlar (action required).
 *   2. "Men yuborganlar"  — open requests where the user's bo'g'in is
 *                            the requester + recently closed (7 days).
 *   3. "Arxiv"            — terminal (CLOSED / CANCELLED) requests.
 *
 * Action buttons (qabul / qisman / rad / qaytarish / bekor) are gated
 * with `useCanAct()` so the UI mirrors backend RBAC exactly. Where an
 * endpoint is not yet wired on the backend the page degrades gracefully:
 * the user sees an Uzbek toast and the dialog stays open for retry.
 */
type TabKey = 'incoming' | 'sent' | 'archive';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function RequestsPage() {
  const bp = useBreakpoint();
  const isMobile = bp === 'xs';
  const { user, locations } = useAuth();
  const { canActOn } = useCanAct();
  const { notify } = useToast();
  const [tab, setTab] = useState<TabKey>('incoming');

  // Pull all visible requests (backend already RBAC-scopes the list).
  // Faza-1 volumes are small — client-side splitting into three tabs is
  // fine for now and keeps the wire chatter to one round-trip.
  const { data, isLoading, error, refetch } =
    useApiQuery<ReplenishmentRequest[]>('/api/replenishment');

  // Track the dialog state by request id + mode. Only one open at a time.
  const [active, setActive] = useState<{
    request: ReplenishmentRequest;
    mode: RequestActionMode;
  } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const userLocationIds = useMemo(
    () => new Set(locations.map((loc) => loc.id)),
    [locations],
  );

  const { incoming, sent, archive } = useMemo(() => {
    const rows = data ?? [];
    const now = Date.now();
    const incomingRows: ReplenishmentRequest[] = [];
    const sentRows: ReplenishmentRequest[] = [];
    const archiveRows: ReplenishmentRequest[] = [];

    for (const row of rows) {
      const isTerminal = TERMINAL_REPLENISHMENT_STATUSES.includes(row.status);
      const isMineAsRequester =
        userLocationIds.has(row.requester_location_id);
      const isMineAsTarget =
        row.target_location_id !== null &&
        userLocationIds.has(row.target_location_id);

      if (isTerminal) {
        // Show the user's own closed/cancelled requests in the archive.
        if (isMineAsRequester || isMineAsTarget) {
          archiveRows.push(row);
        }
        continue;
      }

      if (isMineAsTarget) {
        incomingRows.push(row);
      }
      if (isMineAsRequester) {
        sentRows.push(row);
      }
    }

    // Recently-closed sent requests (last 7 days) also belong in the
    // "Men yuborganlar" tab so the requester can confirm an outcome
    // without flipping to Arxiv.
    for (const row of archiveRows) {
      if (!userLocationIds.has(row.requester_location_id)) continue;
      const closedAt =
        row.closed_at !== null
          ? new Date(row.closed_at).getTime()
          : NaN;
      if (Number.isFinite(closedAt) && now - closedAt < SEVEN_DAYS_MS) {
        sentRows.push(row);
      }
    }

    // PMs / AI assistants are chain-wide read-only — they see everything
    // in Arxiv but nothing in incoming/sent (no location membership).
    return {
      incoming: incomingRows,
      sent: sentRows,
      archive: archiveRows,
    };
  }, [data, userLocationIds]);

  const tabOptions: { value: TabKey; label: string }[] = [
    { value: 'incoming', label: `Menga keluvchi (${incoming.length})` },
    { value: 'sent', label: `Men yuborganlar (${sent.length})` },
    { value: 'archive', label: `Arxiv (${archive.length})` },
  ];

  const rows = tab === 'incoming' ? incoming : tab === 'sent' ? sent : archive;

  async function handleAction(payload: RequestActionPayload): Promise<void> {
    if (active === null) return;
    setIsSubmitting(true);
    try {
      switch (payload.mode) {
        case 'accept_full':
        case 'accept_partial':
          await apiRequest(`/api/replenishment/${active.request.id}/accept`, {
            method: 'POST',
            body: {
              qty_accepted: payload.qty,
              note: payload.note,
            },
          });
          notify(
            'success',
            payload.mode === 'accept_full'
              ? "So'rov to'liq qabul qilindi."
              : 'Qisman qabul qayd etildi.',
          );
          break;
        case 'reject':
          await apiRequest(`/api/replenishment/${active.request.id}/reject`, {
            method: 'POST',
            body: { reason: payload.reason },
          });
          notify('success', "So'rov rad etildi.");
          break;
        case 'return':
          await apiRequest(`/api/replenishment/${active.request.id}/return`, {
            method: 'POST',
            body: {
              qty_returned: payload.qty,
              reason: payload.reason,
            },
          });
          notify('success', 'Tovar qaytarish qayd etildi.');
          break;
      }
      setActive(null);
      refetch();
    } catch (err: unknown) {
      const message =
        err instanceof ApiError
          ? err.status === 404
            ? "Endpoint tayyor emas, biroz keyin urinib ko'ring."
            : err.message
          : "Amalni bajarib bo'lmadi. Qayta urinib ko'ring.";
      notify('error', message);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCancelByRequester(
    request: ReplenishmentRequest,
  ): Promise<void> {
    setIsSubmitting(true);
    try {
      await apiRequest(`/api/replenishment/${request.id}/cancel`, {
        method: 'POST',
        body: { reason: "So'rovchi tomonidan bekor qilindi" },
      });
      notify('success', "So'rov bekor qilindi.");
      refetch();
    } catch (err: unknown) {
      const message =
        err instanceof ApiError
          ? err.message
          : "Bekor qilib bo'lmadi. Qayta urinib ko'ring.";
      notify('error', message);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCancelByFulfiller(
    request: ReplenishmentRequest,
  ): Promise<void> {
    setIsSubmitting(true);
    try {
      await apiRequest(
        `/api/replenishment/${request.id}/cancel-by-fulfiller`,
        {
          method: 'POST',
          body: { reason: 'Yetkazuvchi tomonidan bekor qilindi' },
        },
      );
      notify('success', "So'rov bekor qilindi.");
      refetch();
    } catch (err: unknown) {
      const message =
        err instanceof ApiError
          ? err.status === 404
            ? "Endpoint tayyor emas, biroz keyin urinib ko'ring."
            : err.message
          : "Bekor qilib bo'lmadi. Qayta urinib ko'ring.";
      notify('error', message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title="So'rovnomalar"
        description={
          user !== null
            ? "Sizning bo'g'iningizga keluvchi, siz yuborgan va yopilgan so'rovlar."
            : "To'ldirish so'rovlari."
        }
      />

      <Tabs<TabKey>
        value={tab}
        onValueChange={setTab}
        options={tabOptions}
        ariaLabel="So'rovnomalar bo'limlari"
      />

      <Card>
        {isLoading && <LoadingState />}
        {!isLoading && error !== null && (
          <ErrorState message={error} onRetry={refetch} />
        )}
        {!isLoading && error === null && rows.length === 0 && (
          <EmptyState
            message={
              tab === 'incoming'
                ? "Sizga keluvchi so'rov yo'q — hammasi joyida."
                : tab === 'sent'
                  ? "Siz hech qanday so'rov yubormagansiz."
                  : "Arxivda so'rov yo'q."
            }
          />
        )}
        {!isLoading && error === null && rows.length > 0 && (
          <RequestsTable
            rows={rows}
            tab={tab}
            isMobile={isMobile}
            canActOn={canActOn}
            isSubmitting={isSubmitting}
            onAction={(request, mode) => setActive({ request, mode })}
            onCancelByRequester={handleCancelByRequester}
            onCancelByFulfiller={handleCancelByFulfiller}
          />
        )}
      </Card>

      {active !== null && (
        <RequestActionDialog
          open
          onOpenChange={(next) => {
            if (!isSubmitting && !next) setActive(null);
          }}
          mode={active.mode}
          request={active.request}
          onConfirm={handleAction}
          isSubmitting={isSubmitting}
        />
      )}
    </div>
  );
}

interface RequestsTableProps {
  rows: ReplenishmentRequest[];
  tab: TabKey;
  isMobile: boolean;
  canActOn: (locationId: number | null | undefined) => boolean;
  isSubmitting: boolean;
  onAction: (request: ReplenishmentRequest, mode: RequestActionMode) => void;
  onCancelByRequester: (request: ReplenishmentRequest) => Promise<void>;
  onCancelByFulfiller: (request: ReplenishmentRequest) => Promise<void>;
}

function RequestsTable({
  rows,
  tab,
  isMobile,
  canActOn,
  isSubmitting,
  onAction,
  onCancelByRequester,
  onCancelByFulfiller,
}: RequestsTableProps) {
  if (isMobile) {
    return (
      <MobileCardList
        items={rows.map((row) => ({
          id: row.id,
          title: `#${row.id} · ${row.product_name}`,
          subtitle: `${row.requester_location_name} → ${row.target_location_name ?? '—'}`,
          badge: (
            <Badge variant={REPLENISHMENT_STATUS_VARIANT[row.status]}>
              {REPLENISHMENT_STATUS_LABELS[row.status]}
            </Badge>
          ),
          fields: [
            {
              label: 'Miqdor',
              value: `${formatQty(row.qty_needed)} ${row.product_unit}`,
            },
            {
              label: 'Holat',
              value: describeStatus(row.status, row.production_location_name),
            },
            { label: 'Yaratilgan', value: formatDateTime(row.created_at) },
          ],
          footer: (
            <RowActions
              row={row}
              tab={tab}
              canActOn={canActOn}
              isSubmitting={isSubmitting}
              onAction={onAction}
              onCancelByRequester={onCancelByRequester}
              onCancelByFulfiller={onCancelByFulfiller}
            />
          ),
        }))}
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>#</TableHead>
          <TableHead>Mahsulot</TableHead>
          <TableHead className="text-right">Miqdor</TableHead>
          <TableHead>So'rovchi</TableHead>
          <TableHead>Qabul qiluvchi</TableHead>
          <TableHead>Holat</TableHead>
          <TableHead>Yaratilgan</TableHead>
          <TableHead className="text-right">Amal</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="text-muted-foreground">
              <Link
                to={`/replenishment/${row.id}`}
                className="text-primary hover:underline"
              >
                #{row.id}
              </Link>
            </TableCell>
            <TableCell className="font-medium">{row.product_name}</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatQty(row.qty_needed)} {row.product_unit}
            </TableCell>
            <TableCell>{row.requester_location_name}</TableCell>
            <TableCell>{row.target_location_name ?? '—'}</TableCell>
            <TableCell>
              <div className="flex flex-col gap-1">
                <Badge variant={REPLENISHMENT_STATUS_VARIANT[row.status]}>
                  {REPLENISHMENT_STATUS_LABELS[row.status]}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {describeStatus(row.status, row.production_location_name)}
                </span>
              </div>
            </TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground">
              {formatDateTime(row.created_at)}
            </TableCell>
            <TableCell className="text-right">
              <RowActions
                row={row}
                tab={tab}
                canActOn={canActOn}
                isSubmitting={isSubmitting}
                onAction={onAction}
                onCancelByRequester={onCancelByRequester}
                onCancelByFulfiller={onCancelByFulfiller}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

interface RowActionsProps {
  row: ReplenishmentRequest;
  tab: TabKey;
  canActOn: (locationId: number | null | undefined) => boolean;
  isSubmitting: boolean;
  onAction: (request: ReplenishmentRequest, mode: RequestActionMode) => void;
  onCancelByRequester: (request: ReplenishmentRequest) => Promise<void>;
  onCancelByFulfiller: (request: ReplenishmentRequest) => Promise<void>;
}

function RowActions({
  row,
  tab,
  canActOn,
  isSubmitting,
  onAction,
  onCancelByRequester,
  onCancelByFulfiller,
}: RowActionsProps) {
  const isTerminal = TERMINAL_REPLENISHMENT_STATUSES.includes(row.status);
  if (isTerminal) {
    return (
      <Button variant="outline" size="sm" asChild>
        <Link to={`/replenishment/${row.id}`}>Ko'rish</Link>
      </Button>
    );
  }

  const canReceive = canActOn(row.requester_location_id);
  const canCancelAsRequester = canActOn(row.requester_location_id);
  const canCancelAsFulfiller = canActOn(row.target_location_id);
  // SHIP_TO_REQUESTER (or later) → tovar yo'lda, qabul/rad/qisman menus
  // make sense. Earlier statuses still allow the requester to cancel.
  const isAcceptable =
    row.status === 'SHIP_TO_REQUESTER' ||
    row.status === 'DONE_TO_WAREHOUSE';

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      <Button variant="ghost" size="sm" asChild>
        <Link to={`/replenishment/${row.id}`}>Ochish</Link>
      </Button>

      {tab === 'incoming' && canReceive && isAcceptable && (
        <>
          <Button
            size="sm"
            disabled={isSubmitting}
            onClick={() => onAction(row, 'accept_full')}
          >
            To'liq qabul
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={isSubmitting}
            onClick={() => onAction(row, 'accept_partial')}
          >
            Qisman
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={isSubmitting}
            onClick={() => onAction(row, 'reject')}
          >
            Kelmadi
          </Button>
        </>
      )}

      {canReceive && row.status === 'CLOSED' && (
        <Button
          variant="outline"
          size="sm"
          disabled={isSubmitting}
          onClick={() => onAction(row, 'return')}
        >
          Qaytarish
        </Button>
      )}

      {tab === 'sent' && canCancelAsRequester && (
        <Button
          variant="ghost"
          size="sm"
          disabled={isSubmitting}
          onClick={() => onCancelByRequester(row)}
        >
          Bekor qilish
        </Button>
      )}

      {tab === 'incoming' && !canReceive && canCancelAsFulfiller && (
        <Button
          variant="ghost"
          size="sm"
          disabled={isSubmitting}
          onClick={() => onCancelByFulfiller(row)}
        >
          Bekor qilish
        </Button>
      )}
    </div>
  );
}
