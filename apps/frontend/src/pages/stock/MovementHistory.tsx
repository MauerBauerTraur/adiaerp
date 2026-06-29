import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState, ErrorState, LoadingState } from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { MOVEMENT_REASON_LABELS } from '@/lib/labels';
import { formatDateTime, formatQty } from '@/lib/format';
import type { MovementsResponse } from '@/lib/types';
import { useState } from 'react';

interface MovementHistoryProps {
  /** Restricts history to one location; `null` shows all in scope. */
  locationId: number | null;
}

/** Page size for the movement ledger — matches the backend default. */
const PAGE_SIZE = 50;

/**
 * Stock movement ledger — `GET /api/stock/movements` (M3, §4.4).
 * The endpoint returns a `{ items, total, limit, offset }` envelope; each
 * `item` embeds `product_name` and the from/to location names so no
 * client-side join is needed.
 */
export function MovementHistory({ locationId }: MovementHistoryProps) {
  const [offset, setOffset] = useState(0);

  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (locationId !== null) params.set('location_id', String(locationId));
  const path = `/api/stock/movements?${params.toString()}`;

  const { data, isLoading, error, refetch } =
    useApiQuery<MovementsResponse>(path);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={refetch} />;

  const movements = data?.items ?? [];
  const total = data?.total ?? 0;

  if (movements.length === 0) {
    return <EmptyState message="Harakatlar tarixi bo‘sh." />;
  }

  const pageStart = offset + 1;
  const pageEnd = offset + movements.length;
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Sana</TableHead>
            <TableHead>Mahsulot</TableHead>
            <TableHead>Sabab</TableHead>
            <TableHead>Manba → Qabul</TableHead>
            <TableHead className="text-right">Miqdor</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {movements.map((m) => (
            <TableRow key={m.id}>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {formatDateTime(m.created_at)}
              </TableCell>
              <TableCell className="font-medium">{m.product_name}</TableCell>
              <TableCell>
                <Badge variant="outline">
                  {MOVEMENT_REASON_LABELS[m.reason]}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {(m.from_location_name ?? '—') +
                  ' → ' +
                  (m.to_location_name ?? '—')}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatQty(m.qty)} {m.product_unit}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="flex items-center justify-between px-1 text-sm text-muted-foreground">
        <span>
          {pageStart}–{pageEnd} / {total}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!hasPrev}
            onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
          >
            Oldingi
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!hasNext}
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
          >
            Keyingi
          </Button>
        </div>
      </div>
    </div>
  );
}
