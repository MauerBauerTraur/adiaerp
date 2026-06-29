import { useEffect, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import { LOCATION_TYPE_OPTIONS } from '@/lib/labels';
import type { Location, LocationType } from '@/lib/types';

interface LocationFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing location for edit mode; `null` for create mode. */
  location: Location | null;
  /** Locations available as `parent_id` options. */
  allLocations: Location[];
  /** Called after a successful save so the list can refresh. */
  onSaved: () => void;
}

interface FormState {
  name: string;
  type: LocationType;
  parent_id: string;
  lead_time_days: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  type: 'store',
  parent_id: '',
  lead_time_days: '',
};

/**
 * Create / edit dialog for a chain location (M1).
 * Submits to `POST /api/locations` or `PATCH /api/locations/:id`.
 */
export function LocationFormDialog({
  open,
  onOpenChange,
  location,
  allLocations,
  onSaved,
}: LocationFormDialogProps) {
  const { notify } = useToast();
  const isEdit = location !== null;
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form whenever the dialog opens for a different target.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(
      location
        ? {
            name: location.name,
            // `parent_id` is held as a string for the <select> value;
            // a numeric backend id is stringified at this DOM edge.
            type: location.type,
            parent_id:
              location.parent_id == null ? '' : String(location.parent_id),
            lead_time_days:
              location.lead_time_days === null
                ? ''
                : String(location.lead_time_days),
          }
        : EMPTY_FORM,
    );
  }, [open, location]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const payload = {
      name: form.name.trim(),
      type: form.type,
      parent_id: form.parent_id === '' ? null : Number(form.parent_id),
      lead_time_days:
        form.lead_time_days === '' ? null : Number(form.lead_time_days),
    };

    try {
      if (isEdit && location) {
        await apiRequest(`/api/locations/${location.id}`, {
          method: 'PATCH',
          body: payload,
        });
      } else {
        await apiRequest('/api/locations', { method: 'POST', body: payload });
      }
      notify('success', isEdit ? 'Bo‘g‘in yangilandi.' : 'Bo‘g‘in qo‘shildi.');
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      setError(
        err instanceof ApiError ? err.message : 'Saqlashda xatolik yuz berdi.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit ? 'Bo‘g‘inni tahrirlash' : 'Yangi bo‘g‘in'}
          </DialogTitle>
          <DialogDescription>
            Zanjir bo‘g‘ini ma’lumotlarini kiriting.
          </DialogDescription>
        </DialogHeader>

        <form id="location-form" className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="loc-name">Nomi</Label>
            <Input
              id="loc-name"
              name="name"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="loc-type">Turi</Label>
            <Select
              id="loc-type"
              name="type"
              value={form.type}
              onChange={(e) =>
                setForm({ ...form, type: e.target.value as LocationType })
              }
            >
              {LOCATION_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="loc-parent">Yuqori bo‘g‘in</Label>
            <Select
              id="loc-parent"
              name="parent_id"
              value={form.parent_id}
              onChange={(e) =>
                setForm({ ...form, parent_id: e.target.value })
              }
            >
              <option value="">— Yo‘q —</option>
              {allLocations
                .filter((l) => l.id !== location?.id)
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="loc-lead">Yetkazib berish muddati (kun)</Label>
            <Input
              id="loc-lead"
              name="lead_time_days"
              type="number"
              min={0}
              value={form.lead_time_days}
              onChange={(e) =>
                setForm({ ...form, lead_time_days: e.target.value })
              }
            />
          </div>

          {error && (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Bekor qilish
          </Button>
          <Button type="submit" form="location-form" disabled={isSubmitting}>
            {isSubmitting && (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            )}
            Saqlash
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
