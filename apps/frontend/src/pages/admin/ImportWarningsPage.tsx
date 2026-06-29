import { useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import type {
  ImportWarning,
  ImportWarningSeverity,
  ImportWarningsResponse,
} from '@/lib/types';

/**
 * Faza-2 F2.3 — Sync / import-warning panel (phase-2.md §2.3.3, §4.3).
 *
 * PM-only screen that lists anomalies recorded by the Poster sync, BOM
 * validator and the dynamic min/max recalc cron. Filterable by source
 * and resolved state, with an inline "Hal qilindi" resolve action.
 *
 * Route mounting (PM-only) is wired in `routes/AppRouter.tsx`.
 */
const SEVERITY_VARIANT: Record<
  ImportWarningSeverity,
  'info' | 'warning' | 'danger'
> = {
  info: 'info',
  warning: 'warning',
  error: 'danger',
};

const SEVERITY_LABEL: Record<ImportWarningSeverity, string> = {
  info: 'Ma’lumot',
  warning: 'Ogohlantirish',
  error: 'Xato',
};

// Known sources from phase-2.md §7.3 + ADR-0007. The list is a hint —
// the backend may emit any string, so the table still renders unknown
// sources as plain text.
const SOURCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Barchasi' },
  { value: 'poster.bom', label: 'Poster — retsept' },
  { value: 'poster.leftovers', label: 'Poster — qoldiq' },
  { value: 'poster.sales', label: 'Poster — sotuv' },
  { value: 'poster.seed', label: 'Poster — birinchi yuklash' },
  { value: 'minmax.recalc', label: 'Dynamic recalc' },
];

const RESOLVED_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'false', label: 'Hal qilinmaganlar' },
  { value: 'true', label: 'Hal qilinganlar' },
  { value: '', label: 'Barchasi' },
];

export function ImportWarningsPage() {
  const { notify } = useToast();
  const [source, setSource] = useState<string>('');
  const [resolved, setResolved] = useState<string>('false');
  const [resolvingId, setResolvingId] = useState<number | null>(null);

  const params = new URLSearchParams();
  if (source !== '') params.set('source', source);
  if (resolved !== '') params.set('resolved', resolved);
  const query = params.toString();
  const path = `/api/admin/import-warnings${query ? `?${query}` : ''}`;
  const warnings = useApiQuery<ImportWarningsResponse>(path);

  const items = warnings.data?.items ?? [];

  async function resolveWarning(id: number) {
    setResolvingId(id);
    try {
      await apiRequest(`/api/admin/import-warnings/${id}/resolve`, {
        method: 'POST',
      });
      notify('success', 'Ogohlantirish hal qilindi.');
      warnings.refetch();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Saqlab bo‘lmadi.',
      );
    } finally {
      setResolvingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title="Sync ogohlantirishlar"
        description="Poster sync, retsept mismatch va dynamic recalc anomaliyalari."
      />

      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:gap-4">
        <div className="space-y-1">
          <Label htmlFor="warning-source">Manba</Label>
          <Select
            id="warning-source"
            className="w-full sm:w-56"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            {SOURCE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="warning-resolved">Holat</Label>
          <Select
            id="warning-resolved"
            className="w-full sm:w-56"
            value={resolved}
            onChange={(e) => setResolved(e.target.value)}
          >
            {RESOLVED_OPTIONS.map((opt) => (
              <option key={opt.value || 'all'} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <Card>
        {warnings.isLoading && <LoadingState />}
        {!warnings.isLoading && warnings.error && (
          <ErrorState message={warnings.error} onRetry={warnings.refetch} />
        )}
        {!warnings.isLoading && !warnings.error && items.length === 0 && (
          <EmptyState message="Ogohlantirishlar topilmadi." />
        )}
        {!warnings.isLoading && !warnings.error && items.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sana</TableHead>
                <TableHead>Manba</TableHead>
                <TableHead>Daraja</TableHead>
                <TableHead>Xabar</TableHead>
                <TableHead>Tegishli</TableHead>
                <TableHead>Holat</TableHead>
                <TableHead aria-label="Amallar" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((w: ImportWarning) => (
                <TableRow key={w.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatDateTime(w.created_at)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {w.source}
                  </TableCell>
                  <TableCell>
                    <Badge variant={SEVERITY_VARIANT[w.severity]}>
                      {SEVERITY_LABEL[w.severity]}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-md text-sm">{w.message}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {w.entity ?? '—'}
                  </TableCell>
                  <TableCell>
                    {w.resolved ? (
                      <Badge variant="success">Hal qilingan</Badge>
                    ) : (
                      <Badge variant="outline">Ochiq</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {!w.resolved && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => resolveWarning(w.id)}
                        disabled={resolvingId === w.id}
                      >
                        {resolvingId === w.id ? (
                          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                        ) : (
                          <CheckCircle2 className="size-4" aria-hidden="true" />
                        )}
                        Hal qilindi
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
