import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowRight, Loader2, Plus, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import { FLOW_TYPE_LABELS, FLOW_TYPE_OPTIONS } from '@/lib/labels';
import type { FlowType, Location, LocationFlow } from '@/lib/types';

interface LocationFlowsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** All chain locations — both the flow-endpoint pickers and label lookups. */
  allLocations: Location[];
  /**
   * Called after any successful add/delete so the parent can revalidate
   * dependent views (the EcosystemCanvas reads `location_flows` on its next
   * dashboard refetch — see D-0026 / commit 837e159).
   */
  onChanged?: () => void;
}

/**
 * EPIC 2.1 — admin connection (oqim) management. The PM picks a source and a
 * target bo'g'in plus a flow type and the pair is persisted to
 * `location_flows`. Existing flows are listed with a delete affordance.
 *
 * The change shows up on the EcosystemCanvas because the dashboard ecosystem
 * aggregate already projects `location_flows` into `chain_edges` (D-0026) and
 * the canvas merges them on top of the derived layer edges (commit 837e159).
 *
 * ── Backend status ──────────────────────────────────────────────────────────
 * TODO(backend, Wave-5): the CRUD endpoints below DO NOT EXIST yet. Today only
 * `GET /api/dashboard/ecosystem` reads `location_flows` (read-only). This UI
 * targets the contract:
 *
 *   GET    /api/locations/flows       → LocationFlow[]
 *   POST   /api/locations/flows       { from_location_id, to_location_id,
 *                                       flow_type, note? } → { flow }
 *   DELETE /api/locations/flows/:id   → 204
 *
 * Until backend-engineer ships it the list load surfaces a friendly notice
 * instead of crashing, and submits will fail with the backend's error message.
 */
export function LocationFlowsDialog({
  open,
  onOpenChange,
  allLocations,
  onChanged,
}: LocationFlowsDialogProps) {
  const { notify } = useToast();

  const [flows, setFlows] = useState<LocationFlow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [flowType, setFlowType] = useState<FlowType>('forward');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const nameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const loc of allLocations) map.set(loc.id, loc.name);
    return map;
  }, [allLocations]);

  // (Re)load existing flows whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSubmitError(null);
    setFromId('');
    setToId('');
    setFlowType('forward');

    async function load() {
      setIsLoading(true);
      setLoadError(null);
      try {
        const data = await apiRequest<LocationFlow[]>('/api/locations/flows');
        if (!cancelled) setFlows(data);
      } catch (err: unknown) {
        if (cancelled) return;
        setFlows([]);
        setLoadError(
          err instanceof ApiError
            ? err.message
            : 'Oqimlarni yuklab bo‘lmadi.',
        );
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function refresh() {
    try {
      const data = await apiRequest<LocationFlow[]>('/api/locations/flows');
      setFlows(data);
    } catch {
      // Keep the optimistic state on a transient refresh error; the next
      // open re-syncs from the server.
    }
  }

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError(null);

    if (fromId === '' || toId === '') {
      setSubmitError('Manba va qabul bo‘g‘inini tanlang.');
      return;
    }
    if (fromId === toId) {
      setSubmitError('Manba va qabul bo‘g‘ini bir xil bo‘la olmaydi.');
      return;
    }

    setIsSubmitting(true);
    try {
      await apiRequest('/api/locations/flows', {
        method: 'POST',
        body: {
          from_location_id: Number(fromId),
          to_location_id: Number(toId),
          flow_type: flowType,
        },
      });
      notify('success', 'Oqim qo‘shildi.');
      setFromId('');
      setToId('');
      await refresh();
      onChanged?.();
    } catch (err: unknown) {
      setSubmitError(
        err instanceof ApiError ? err.message : 'Oqim qo‘shishda xatolik.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDelete(flow: LocationFlow) {
    setDeletingId(flow.id);
    try {
      await apiRequest(`/api/locations/flows/${flow.id}`, { method: 'DELETE' });
      notify('success', 'Oqim o‘chirildi.');
      setFlows((prev) => prev.filter((f) => f.id !== flow.id));
      onChanged?.();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Oqimni o‘chirishda xatolik.',
      );
    } finally {
      setDeletingId(null);
    }
  }

  function labelFor(id: number): string {
    return nameById.get(id) ?? `#${id}`;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Bo‘g‘inlar orasidagi oqimlar</DialogTitle>
          <DialogDescription>
            Manba bo‘g‘indan qabul qiluvchi bo‘g‘inga oqim qo‘shing yoki
            o‘chiring. O‘zgarish ekotizim sxemasida aks etadi.
          </DialogDescription>
        </DialogHeader>

        {/* Add form */}
        <form
          id="flow-add-form"
          className="grid grid-cols-1 gap-3 rounded-lg border border-border/60 bg-card/40 p-4 sm:grid-cols-[1fr_auto_1fr_1fr_auto] sm:items-end"
          onSubmit={handleAdd}
        >
          <div className="space-y-1.5">
            <Label htmlFor="flow-from">Manba bo‘g‘in</Label>
            <Select
              id="flow-from"
              value={fromId}
              onChange={(e) => setFromId(e.target.value)}
            >
              <option value="">— Tanlang —</option>
              {allLocations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="hidden pb-2.5 text-muted-foreground sm:block">
            <ArrowRight className="size-4" aria-hidden="true" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="flow-to">Qabul bo‘g‘in</Label>
            <Select
              id="flow-to"
              value={toId}
              onChange={(e) => setToId(e.target.value)}
            >
              <option value="">— Tanlang —</option>
              {allLocations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="flow-type">Oqim turi</Label>
            <Select
              id="flow-type"
              value={flowType}
              onChange={(e) => setFlowType(e.target.value as FlowType)}
            >
              {FLOW_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>

          <Button type="submit" disabled={isSubmitting} className="sm:mb-0">
            {isSubmitting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Plus className="size-4" aria-hidden="true" />
            )}
            Qo‘shish
          </Button>
        </form>

        {submitError && (
          <p
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {submitError}
          </p>
        )}

        {/* Existing flows */}
        <div className="max-h-72 space-y-2 overflow-y-auto">
          {isLoading && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Yuklanmoqda…
            </p>
          )}

          {!isLoading && loadError && (
            <p
              className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
              role="status"
            >
              {loadError}
            </p>
          )}

          {!isLoading && !loadError && flows.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Hozircha oqimlar yo‘q.
            </p>
          )}

          {!isLoading &&
            !loadError &&
            flows.map((flow) => (
              <div
                key={flow.id}
                className="flex items-center gap-3 rounded-md border border-border/60 bg-card/40 px-3 py-2"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                  <span className="truncate font-medium">
                    {labelFor(flow.from_location_id)}
                  </span>
                  <ArrowRight
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="truncate font-medium">
                    {labelFor(flow.to_location_id)}
                  </span>
                </div>
                <Badge variant="outline" className="shrink-0">
                  {FLOW_TYPE_LABELS[flow.flow_type]}
                </Badge>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  disabled={deletingId === flow.id}
                  onClick={() => handleDelete(flow)}
                  aria-label={`${labelFor(flow.from_location_id)} → ${labelFor(
                    flow.to_location_id,
                  )} oqimini o‘chirish`}
                >
                  {deletingId === flow.id ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                </Button>
              </div>
            ))}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Yopish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
