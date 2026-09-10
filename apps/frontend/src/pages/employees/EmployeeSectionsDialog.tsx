import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import { HIDDEN_GROUPS, navSectionsForRole } from '@/lib/navigation';
import type { User, UserPageAccess } from '@/lib/types';

/**
 * Per-user bo'lim (page) access — migration 0061.
 *
 * Replaces the old "Bo'g'inlar" dialog, which assigned warehouses. What an
 * admin actually needed here was the left-hand navigation: which of
 * Boshqaruv paneli / Modullar / Ishlab chiqarish / Ma'lumotnoma — and which
 * screens inside them — this user may open. The warehouse a user works in is
 * now derived from their role when the account is created.
 *
 * Storage semantics (`PUT /api/users/:id/pages`):
 *   - **empty array** = no override, the role default applies. We save that
 *     shape when *everything* is ticked, so screens added to the app later
 *     stay visible to this user instead of silently disappearing.
 *   - **non-empty** = exactly these screens.
 *   - saving with nothing ticked is blocked in the UI — it would round-trip
 *     as "no override" and grant everything, the opposite of the intent.
 */
interface EmployeeSectionsDialogProps {
  /** The user whose access is being edited; `null` keeps the dialog closed. */
  user: User | null;
  onOpenChange: (open: boolean) => void;
}

/** Checkbox that can also render the "some children ticked" third state. */
function TriCheckbox({
  id,
  checked,
  indeterminate,
  onChange,
  disabled,
}: {
  id: string;
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  // `indeterminate` is a DOM property with no HTML attribute — React cannot
  // set it declaratively, so it is mirrored here on every render.
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      id={id}
      type="checkbox"
      className="size-4 rounded border-border"
      checked={checked}
      onChange={onChange}
      disabled={disabled === true}
    />
  );
}

export function EmployeeSectionsDialog({
  user,
  onOpenChange,
}: EmployeeSectionsDialogProps) {
  const { notify } = useToast();
  const open = user !== null;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Only what this user's ROLE can reach is offered — the role stays the
  // outer gate, so an admin is never shown a screen the grant could not
  // actually open.
  const sections = useMemo(
    () =>
      user === null
        ? []
        : navSectionsForRole(user.role).filter(
            (s) => !HIDDEN_GROUPS.includes(s.key),
          ),
    [user],
  );

  const allPaths = useMemo(
    () => sections.flatMap((s) => s.items.map((i) => i.path)),
    [sections],
  );

  const refetch = useCallback(async () => {
    if (user === null) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await apiRequest<UserPageAccess>(
        `/api/users/${user.id}/pages`,
      );
      const stored = res.paths ?? [];
      // No stored rows = role default = everything the role can see. Show it
      // ticked, because that is what the user experiences today.
      setSelected(
        stored.length === 0
          ? new Set(allPaths)
          : new Set(stored.filter((p) => allPaths.includes(p))),
      );
    } catch (err: unknown) {
      setLoadError(
        err instanceof ApiError
          ? err.message
          : 'Bo‘limlar ro‘yxatini yuklab bo‘lmadi.',
      );
    } finally {
      setIsLoading(false);
    }
  }, [user, allPaths]);

  useEffect(() => {
    if (open) void refetch();
  }, [open, refetch]);

  function togglePath(path: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleGroup(paths: readonly string[]) {
    setSelected((current) => {
      const next = new Set(current);
      const allOn = paths.every((p) => next.has(p));
      for (const p of paths) {
        if (allOn) next.delete(p);
        else next.add(p);
      }
      return next;
    });
  }

  const isAllSelected =
    allPaths.length > 0 && allPaths.every((p) => selected.has(p));

  async function handleSave() {
    if (user === null || selected.size === 0) return;
    setIsSaving(true);
    try {
      // Everything ticked → store the empty ("no override") shape so future
      // screens are not locked out for this user.
      const paths = isAllSelected ? [] : allPaths.filter((p) => selected.has(p));
      await apiRequest(`/api/users/${user.id}/pages`, {
        method: 'PUT',
        body: { paths },
      });
      notify('success', 'Bo‘limlar saqlandi.');
      onOpenChange(false);
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Bo‘limlar saqlanmadi.',
      );
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {user ? `${user.name} — bo‘limlar` : 'Bo‘limlar'}
          </DialogTitle>
          <DialogDescription>
            Foydalanuvchi chap menyuda qaysi bo‘limlar va sahifalarni ko‘rishini
            belgilang.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
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

          {!isLoading && !loadError && sections.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Bu rol uchun hech qanday bo‘lim mavjud emas.
            </p>
          )}

          {!isLoading &&
            !loadError &&
            sections.map((section) => {
              const paths = section.items.map((i) => i.path);
              const onCount = paths.filter((p) => selected.has(p)).length;
              const GroupIcon = section.icon;
              return (
                <fieldset
                  key={section.key}
                  className="rounded-md border border-border p-3"
                >
                  <legend className="px-1">
                    <label
                      className="flex items-center gap-2 text-sm font-semibold"
                      htmlFor={`section-${section.key}`}
                    >
                      <TriCheckbox
                        id={`section-${section.key}`}
                        checked={onCount === paths.length}
                        indeterminate={onCount > 0}
                        onChange={() => toggleGroup(paths)}
                        disabled={isSaving}
                      />
                      <GroupIcon
                        className="size-4 text-muted-foreground"
                        aria-hidden="true"
                      />
                      {section.label}
                    </label>
                  </legend>

                  <ul className="mt-1 space-y-0.5 pl-6">
                    {section.items.map((item) => {
                      const ItemIcon = item.icon;
                      return (
                        <li key={item.path}>
                          <label
                            className="flex items-center gap-2 rounded-sm px-2 py-1 text-sm hover:bg-muted/40"
                            htmlFor={`page-${item.path}`}
                          >
                            <input
                              id={`page-${item.path}`}
                              type="checkbox"
                              className="size-4 rounded border-border"
                              checked={selected.has(item.path)}
                              onChange={() => togglePath(item.path)}
                              disabled={isSaving}
                            />
                            <ItemIcon
                              className="size-3.5 shrink-0 text-muted-foreground"
                              aria-hidden="true"
                            />
                            <span>{item.label}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </fieldset>
              );
            })}

          {!isLoading && !loadError && selected.size === 0 && sections.length > 0 && (
            <p className="text-xs text-destructive" role="alert">
              Kamida bitta bo‘lim tanlanishi kerak.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Bekor qilish
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={isLoading || isSaving || selected.size === 0}
          >
            {isSaving ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Save className="size-4" aria-hidden="true" />
            )}
            Saqlash
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
