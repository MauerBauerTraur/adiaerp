import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Star, X, Plus } from 'lucide-react';
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
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import type { Location, User, UserLocation } from '@/lib/types';

/**
 * F4.1 — per-user M:N location management.
 *
 * Opens for any selected row in `EmployeesPage`. Three operations:
 *   - **assign**       — `POST /api/users/:id/locations`
 *   - **set primary**  — `PUT  /api/users/:id/locations/:lid/primary`
 *   - **unassign**     — `DELETE /api/users/:id/locations/:lid`
 *
 * The primary row cannot be removed — the backend rejects it with 422
 * and the UI disables the remove button to match. The user must
 * promote another location first.
 */
interface EmployeeLocationsDialogProps {
  /** The user whose assignments are being edited; `null` keeps the dialog closed. */
  user: User | null;
  /** All locations available for assignment. */
  allLocations: Location[];
  onOpenChange: (open: boolean) => void;
  /** Called after any mutation so the parent list can refresh `users.location_id`. */
  onChanged: () => void;
}

export function EmployeeLocationsDialog({
  user,
  allLocations,
  onOpenChange,
  onChanged,
}: EmployeeLocationsDialogProps) {
  const { notify } = useToast();
  const open = user !== null;

  const [assignments, setAssignments] = useState<UserLocation[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingOp, setPendingOp] = useState<string | null>(null);
  const [newLocationId, setNewLocationId] = useState<string>('');

  const refetch = useCallback(async () => {
    if (user === null) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const rows = await apiRequest<UserLocation[]>(
        `/api/users/${user.id}/locations`,
      );
      setAssignments(rows);
    } catch (err: unknown) {
      setLoadError(
        err instanceof ApiError
          ? err.message
          : 'Bo‘g‘inlar ro‘yxatini yuklab bo‘lmadi.',
      );
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (open) {
      setNewLocationId('');
      void refetch();
    }
  }, [open, refetch]);

  /** Location ids not yet assigned to the user — surfaced in the picker. */
  const availableForAssignment = useMemo(() => {
    const assignedIds = new Set(assignments.map((a) => a.location_id));
    return allLocations.filter((l) => !assignedIds.has(l.id));
  }, [allLocations, assignments]);

  async function handleAssign() {
    if (user === null || newLocationId === '') return;
    const locationId = Number(newLocationId);
    if (!Number.isFinite(locationId)) return;

    setPendingOp('assign');
    try {
      await apiRequest(`/api/users/${user.id}/locations`, {
        method: 'POST',
        body: { location_id: locationId, is_primary: false },
      });
      notify('success', 'Bo‘g‘in qo‘shildi.');
      setNewLocationId('');
      await refetch();
      onChanged();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Bo‘g‘in qo‘shilmadi.',
      );
    } finally {
      setPendingOp(null);
    }
  }

  async function handleSetPrimary(locationId: number) {
    if (user === null) return;
    setPendingOp(`primary-${locationId}`);
    try {
      await apiRequest(
        `/api/users/${user.id}/locations/${locationId}/primary`,
        { method: 'PUT' },
      );
      notify('success', 'Asosiy bo‘g‘in yangilandi.');
      await refetch();
      onChanged();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Asosiy bo‘g‘in o‘zgartirilmadi.',
      );
    } finally {
      setPendingOp(null);
    }
  }

  async function handleUnassign(locationId: number) {
    if (user === null) return;
    setPendingOp(`unassign-${locationId}`);
    try {
      await apiRequest(`/api/users/${user.id}/locations/${locationId}`, {
        method: 'DELETE',
      });
      notify('success', 'Bo‘g‘in olib tashlandi.');
      await refetch();
      onChanged();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Bo‘g‘in olib tashlanmadi.',
      );
    } finally {
      setPendingOp(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {user ? `${user.name} — bo‘g‘inlar` : 'Bo‘g‘inlar'}
          </DialogTitle>
          <DialogDescription>
            Hodim biriktirilgan bo‘g‘inlarni boshqarish.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {isLoading && (
            <p
              className="flex items-center gap-2 text-sm text-muted-foreground"
              role="status"
            >
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Yuklanmoqda…
            </p>
          )}

          {loadError && (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {loadError}
            </p>
          )}

          {!isLoading && !loadError && (
            <ul className="space-y-2">
              {assignments.length === 0 && (
                <li className="text-sm text-muted-foreground">
                  Bo‘g‘in biriktirilmagan.
                </li>
              )}
              {assignments.map((a) => {
                const isPrimary = a.is_primary;
                const opKey = pendingOp;
                return (
                  <li
                    key={a.location_id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border bg-card/40 px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{a.name}</span>
                      {isPrimary && (
                        <Badge variant="success" className="gap-1">
                          <Star className="size-3" aria-hidden="true" />
                          Asosiy
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {!isPrimary && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleSetPrimary(a.location_id)}
                          disabled={opKey !== null}
                        >
                          {opKey === `primary-${a.location_id}` && (
                            <Loader2
                              className="size-3 animate-spin"
                              aria-hidden="true"
                            />
                          )}
                          Asosiy qil
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`${a.name} ni olib tashlash`}
                        title={
                          isPrimary
                            ? 'Asosiy bo‘g‘inni o‘chirib bo‘lmaydi — avval boshqasini asosiy qiling.'
                            : 'Olib tashlash'
                        }
                        onClick={() => handleUnassign(a.location_id)}
                        disabled={isPrimary || opKey !== null}
                      >
                        {opKey === `unassign-${a.location_id}` ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <X className="size-4" />
                        )}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {!isLoading && !loadError && availableForAssignment.length > 0 && (
            <div className="flex items-end gap-2 border-t border-border pt-3">
              <div className="flex-1 space-y-1">
                <label
                  className="text-xs text-muted-foreground"
                  htmlFor="add-location"
                >
                  Yangi bo‘g‘in qo‘shish
                </label>
                <Select
                  id="add-location"
                  value={newLocationId}
                  onChange={(e) => setNewLocationId(e.target.value)}
                  disabled={pendingOp !== null}
                >
                  <option value="">— Tanlanmagan —</option>
                  {availableForAssignment.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </div>
              <Button
                type="button"
                onClick={handleAssign}
                disabled={newLocationId === '' || pendingOp !== null}
              >
                {pendingOp === 'assign' ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Plus className="size-4" aria-hidden="true" />
                )}
                Qo‘shish
              </Button>
            </div>
          )}
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
