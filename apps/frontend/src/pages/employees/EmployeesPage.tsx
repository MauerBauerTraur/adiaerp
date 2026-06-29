import { useMemo, useState } from 'react';
import {
  MapPin,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import {
  FilterPopover,
  type FilterGroup,
  type FilterValue,
} from '@/components/ui/filter-popover';
import { ViewToggle, useViewMode } from '@/components/ViewToggle';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { apiRequest, ApiError } from '@/lib/api-client';
import { ROLE_LABELS, ROLE_OPTIONS } from '@/lib/labels';
import type { Location, Role, User } from '@/lib/types';
import { useToast } from '@/components/ui/toast';
import { EmployeeFormDialog } from './EmployeeFormDialog';
import { EmployeeLocationsDialog } from './EmployeeLocationsDialog';
import { TelegramLinkButton } from './TelegramLinkButton';

// ─── Role color scheme ────────────────────────────────────────────────────────

type RoleColorCfg = {
  ring: string;
  avatarBg: string;
  avatarText: string;
  badge: string;
};

const ROLE_COLORS: Partial<Record<Role, RoleColorCfg>> = {
  super_admin: {
    ring: 'ring-violet-400',
    avatarBg: 'bg-violet-100 dark:bg-violet-950/50',
    avatarText: 'text-violet-700 dark:text-violet-300',
    badge: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300',
  },
  pm: {
    ring: 'ring-blue-400',
    avatarBg: 'bg-blue-100 dark:bg-blue-950/50',
    avatarText: 'text-blue-700 dark:text-blue-300',
    badge: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300',
  },
  production_manager: {
    ring: 'ring-amber-400',
    avatarBg: 'bg-amber-100 dark:bg-amber-950/50',
    avatarText: 'text-amber-700 dark:text-amber-300',
    badge: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300',
  },
  raw_warehouse_manager: {
    ring: 'ring-emerald-400',
    avatarBg: 'bg-emerald-100 dark:bg-emerald-950/50',
    avatarText: 'text-emerald-700 dark:text-emerald-300',
    badge: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300',
  },
};

const DEFAULT_ROLE_COLOR: RoleColorCfg = {
  ring: 'ring-border',
  avatarBg: 'bg-muted',
  avatarText: 'text-muted-foreground',
  badge: 'bg-muted text-muted-foreground border-border',
};

function roleColor(role: Role): RoleColorCfg {
  return ROLE_COLORS[role] ?? DEFAULT_ROLE_COLOR;
}

function initials(name: string): string {
  return name
    .split(' ')
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?';
}

// ─── Stat strip ──────────────────────────────────────────────────────────────

const STAT_ROLES: Role[] = ['super_admin', 'pm', 'production_manager', 'raw_warehouse_manager'];

function StatStrip({ users }: { users: User[] }) {
  const counts = useMemo(() => {
    const c: Partial<Record<Role, number>> = {};
    for (const u of users) c[u.role] = (c[u.role] ?? 0) + 1;
    return c;
  }, [users]);

  return (
    <div className="flex flex-wrap gap-2">
      {STAT_ROLES.map((role) => {
        const count = counts[role] ?? 0;
        if (count === 0) return null;
        const cfg = roleColor(role);
        return (
          <div
            key={role}
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${cfg.badge}`}
          >
            <span className={`size-2 rounded-full ${cfg.ring.replace('ring-', 'bg-')}`} />
            {ROLE_LABELS[role]}
            <span className="tabular-nums font-bold">{count}</span>
          </div>
        );
      })}
      <div className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground">
        Jami
        <span className="tabular-nums font-bold text-foreground">{users.length}</span>
      </div>
    </div>
  );
}

// ─── Filter ──────────────────────────────────────────────────────────────────

const TG_STATUS_VALUES = { linked: 'linked', unlinked: 'unlinked' } as const;

// ─── Main component ──────────────────────────────────────────────────────────

export function EmployeesPage() {
  const { user: currentUser } = useAuth();
  const { notify } = useToast();
  const users = useApiQuery<User[]>('/api/users');
  const locations = useApiQuery<Location[]>('/api/locations');

  const [createOpen, setCreateOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [locationsUser, setLocationsUser] = useState<User | null>(null);
  const [deletingUser, setDeletingUser] = useState<User | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [view, setView] = useViewMode('employees', 'card');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterValue>({});

  const locationNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const l of locations.data ?? []) map.set(l.id, l.name);
    return map;
  }, [locations.data]);

  const filterGroups = useMemo<FilterGroup[]>(
    () => [
      { key: 'role', label: 'Rol', options: ROLE_OPTIONS, searchable: true },
      {
        key: 'tg',
        label: 'Telegram',
        options: [
          { value: TG_STATUS_VALUES.linked, label: 'Ulangan' },
          { value: TG_STATUS_VALUES.unlinked, label: 'Ulanmagan' },
        ],
      },
    ],
    [],
  );

  const allRows = useMemo(() => users.data ?? [], [users.data]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const roleFilter = filter['role'] ?? [];
    const tgFilter = filter['tg'] ?? [];
    return allRows.filter((u) => {
      if (q !== '') {
        const haystack = `${u.name} ${u.username}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (roleFilter.length > 0 && !roleFilter.includes(u.role)) return false;
      if (tgFilter.length > 0) {
        const linked = u.telegram_id != null;
        const matches = tgFilter.some((v) =>
          v === TG_STATUS_VALUES.linked ? linked : !linked,
        );
        if (!matches) return false;
      }
      return true;
    });
  }, [allRows, search, filter]);

  async function confirmDelete() {
    if (deletingUser === null) return;
    setIsDeleting(true);
    try {
      await apiRequest(`/api/users/${deletingUser.id}`, { method: 'DELETE' });
      notify('success', `${deletingUser.name} o'chirildi.`);
      setDeletingUser(null);
      users.refetch();
    } catch (err) {
      notify('error', err instanceof ApiError ? err.message : "O'chirishda xatolik.");
    } finally {
      setIsDeleting(false);
    }
  }

  // ─── Card ─────────────────────────────────────────────────────────────────

  function renderCard(u: User) {
    const cfg = roleColor(u.role);
    const abbr = initials(u.name);
    const primary = u.location_id
      ? (locationNameById.get(u.location_id) ?? `#${u.location_id}`)
      : null;
    const isSelf = currentUser?.id === u.id;

    return (
      <div
        key={u.id}
        data-testid={`employee-card-${u.id}`}
        className="flex flex-col gap-0 overflow-hidden rounded-2xl border border-border/50 bg-card shadow-sm transition-shadow hover:shadow-md"
      >
        {/* Top section */}
        <div className="flex items-start gap-3 p-4">
          <div
            className={`flex size-11 shrink-0 items-center justify-center rounded-full ring-2 ${cfg.ring} ${cfg.avatarBg} text-sm font-bold ${cfg.avatarText}`}
          >
            {abbr}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-bold leading-tight">{u.name}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">@{u.username}</p>
          </div>
        </div>

        {/* Badges */}
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border/40 bg-muted/20 px-4 py-2">
          <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${cfg.badge}`}
          >
            {ROLE_LABELS[u.role]}
          </span>
          {primary && (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <MapPin className="size-3 shrink-0" aria-hidden="true" />
              {primary}
            </span>
          )}
          {u.telegram_id != null && (
            <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-600 dark:bg-sky-950/40 dark:text-sky-400">
              TG ulangan
            </span>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 border-t border-border/40 px-3 py-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => setEditingUser(u)}
            aria-label={`${u.name} ni tahrirlash`}
          >
            <Pencil className="size-3.5" />
            Tahrirlash
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => setLocationsUser(u)}
          >
            <MapPin className="size-3.5" />
            {"Bo'g'inlar"}
          </Button>
          <div className="flex-1" />
          <TelegramLinkButton user={u} />
          {!isSelf && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 text-destructive/60 hover:text-destructive"
              aria-label={`${u.name} ni o'chirish`}
              onClick={() => setDeletingUser(u)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    );
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="mx-auto max-w-[120rem] space-y-5">
      <PageHeader
        title="Foydalanuvchilar"
        description="Rollar, biriktirilgan bo'g'inlar va Telegram ulanishi."
        dateTime
        filter={
          <FilterPopover groups={filterGroups} value={filter} onApply={setFilter} />
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            <ViewToggle value={view} onChange={setView} />
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" aria-hidden="true" />
              Yangi foydalanuvchi
            </Button>
          </div>
        }
      />

      {/* Stats */}
      {allRows.length > 0 && <StatStrip users={allRows} />}

      {/* Search */}
      <div className="relative max-w-sm">
        <Search
          className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Ism yoki foydalanuvchi nomi…"
          className="h-9 pl-8 pr-8"
        />
        {search !== '' && (
          <button
            type="button"
            onClick={() => setSearch('')}
            className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground hover:bg-accent"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      <Card
        className={
          view === 'card' ? 'border-0 bg-transparent p-0 shadow-none' : undefined
        }
      >
        {users.isLoading && <LoadingState />}
        {!users.isLoading && users.error && (
          <ErrorState message={users.error} onRetry={users.refetch} />
        )}
        {!users.isLoading && !users.error && rows.length === 0 && (
          <EmptyState
            message={
              allRows.length === 0
                ? 'Foydalanuvchilar topilmadi.'
                : 'Filtr yoki qidiruv bo\'yicha foydalanuvchi topilmadi.'
            }
          />
        )}

        {/* Card view */}
        {!users.isLoading && !users.error && rows.length > 0 && view === 'card' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {rows.map(renderCard)}
          </div>
        )}

        {/* Table view */}
        {!users.isLoading && !users.error && rows.length > 0 && view === 'table' && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ism-familiya</TableHead>
                <TableHead>Login</TableHead>
                <TableHead>Rol</TableHead>
                <TableHead>Asosiy bo'g'in</TableHead>
                <TableHead>Telegram</TableHead>
                <TableHead className="w-52 text-right">Amal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((u) => {
                const cfg = roleColor(u.role);
                const abbr = initials(u.name);
                const isSelf = currentUser?.id === u.id;
                return (
                  <TableRow key={u.id} data-testid={`employee-row-${u.id}`}>
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <div
                          className={`flex size-8 shrink-0 items-center justify-center rounded-full ring-2 ${cfg.ring} ${cfg.avatarBg} text-xs font-bold ${cfg.avatarText}`}
                        >
                          {abbr}
                        </div>
                        <span className="font-medium">{u.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      @{u.username}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${cfg.badge}`}
                      >
                        {ROLE_LABELS[u.role]}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {u.location_id
                        ? (locationNameById.get(u.location_id) ?? `#${u.location_id}`)
                        : <span className="italic">Butun zanjir</span>}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <TelegramLinkButton user={u} />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 gap-1.5 text-xs"
                          onClick={() => setEditingUser(u)}
                        >
                          <Pencil className="size-3.5" />
                          Tahrirlash
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 gap-1.5 text-xs"
                          onClick={() => setLocationsUser(u)}
                        >
                          <MapPin className="size-3.5" />
                          {"Bo'g'inlar"}
                        </Button>
                        {!isSelf && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-8 text-destructive/60 hover:text-destructive"
                            onClick={() => setDeletingUser(u)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Dialogs */}
      <EmployeeFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        locations={locations.data ?? []}
        onSaved={users.refetch}
      />

      <EmployeeFormDialog
        open={editingUser !== null}
        onOpenChange={(open) => { if (!open) setEditingUser(null); }}
        user={editingUser}
        locations={locations.data ?? []}
        onSaved={users.refetch}
      />

      <EmployeeLocationsDialog
        user={locationsUser}
        allLocations={locations.data ?? []}
        onOpenChange={(open) => { if (!open) setLocationsUser(null); }}
        onChanged={users.refetch}
      />

      <Dialog
        open={deletingUser !== null}
        onOpenChange={(open) => { if (!open) setDeletingUser(null); }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{"Foydalanuvchini o'chirish"}</DialogTitle>
            <DialogDescription>
              <strong>{deletingUser?.name}</strong> (@{deletingUser?.username}) ni o'chirishni tasdiqlaysizmi?
              Ular tizimga kira olmaydi.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isDeleting}
              onClick={() => setDeletingUser(null)}
            >
              Bekor qilish
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={isDeleting}
              onClick={confirmDelete}
            >
              {isDeleting ? "O'chirilmoqda…" : "Ha, o'chirish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
