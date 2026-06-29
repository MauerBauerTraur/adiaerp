import { useState } from 'react';
import { MapPin, Loader2 } from 'lucide-react';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/hooks/useAuth';
import { ApiError } from '@/lib/api-client';

/**
 * F4.1 / ADR-0012 — header switcher that lets multi-location users pick
 * which bo'g'in scopes their RBAC view. Hidden when the user has fewer
 * than two assignments (single-location managers have nothing to switch).
 *
 * On selection it calls `setActiveLocation()` (auth provider) which
 * persists the choice, sends `PATCH /api/auth/active-location` for the
 * audit row, and updates context. A full `window.location.reload()`
 * follows so every cached page-level fetch picks up the new RBAC scope —
 * cheaper and safer than re-plumbing every screen for a context dep.
 */
export function LocationSwitcher() {
  const { locations, activeLocationId, setActiveLocation } = useAuth();
  const { notify } = useToast();
  const [isSwitching, setIsSwitching] = useState(false);

  // Single-location users (most managers) have nothing to switch.
  if (locations.length < 2) return null;

  const currentLocation =
    locations.find((l) => l.id === activeLocationId) ??
    locations.find((l) => l.is_primary) ??
    locations[0];

  async function handleChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const nextId = Number(event.target.value);
    if (!Number.isFinite(nextId) || nextId === activeLocationId) return;

    const target = locations.find((l) => l.id === nextId);
    if (target === undefined) return;

    setIsSwitching(true);
    try {
      await setActiveLocation(nextId);
      notify('success', `Aktiv bo‘g‘in o‘zgartirildi: ${target.name}`);
      // Reload so every cached fetch refreshes under the new RBAC
      // scope. Done AFTER the toast renders (microtask flush) so the
      // user sees the confirmation before the page reload starts.
      window.setTimeout(() => {
        window.location.reload();
      }, 600);
    } catch (err: unknown) {
      const message =
        err instanceof ApiError
          ? err.message
          : 'Aktiv bo‘g‘inni o‘zgartirib bo‘lmadi.';
      notify('error', message);
      setIsSwitching(false);
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <MapPin
        className="hidden size-4 shrink-0 text-muted-foreground sm:inline-block"
        aria-hidden="true"
      />
      <label htmlFor="location-switcher" className="sr-only">
        Aktiv bo‘g‘in
      </label>
      <div className="relative w-36 sm:w-56">
        <Select
          id="location-switcher"
          value={currentLocation?.id ?? ''}
          onChange={handleChange}
          disabled={isSwitching}
          aria-label="Aktiv bo‘g‘in tanlash"
        >
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.is_primary ? '⭐ ' : ''}
              {l.name}
            </option>
          ))}
        </Select>
        {isSwitching && (
          <Loader2
            className="pointer-events-none absolute right-9 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  );
}
