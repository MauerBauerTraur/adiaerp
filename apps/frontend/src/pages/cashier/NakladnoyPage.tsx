import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
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
import { useApiQuery } from '@/hooks/useApiQuery';
import type { NakladnoyListResponse, Nakladnoy } from '@/lib/types';
import { NakladnoyView } from './NakladnoyView';

/**
 * EPIC 8.4 / 8.5 — nakladnoy ro'yxati (admin ko'rinishi).
 *
 * "10 Napoleon sotildi" → retseptdan (BOM) avtomatik hisoblangan
 * nakladnoy: hamir uchun / krem uchun bo'limlar + ITOGO umumiy material.
 * Bu sahifa shu nakladnoylar ro'yxatini ko'rsatadi; har birini bosib
 * to'liq bo'limlarga ajratilgan ko'rinishni ochish mumkin.
 *
 * Backend: `GET /api/nakladnoy` hali yo'q (P11 — derive/write qatlam).
 * Endpoint 404 qaytarsa, sahifa "tayyorlanmoqda" empty-state ko'rsatadi
 * — UI shakli backend kontrakti uchun namuna bo'lib qoladi.
 * TODO(backend): EPIC 8.4 `GET /api/nakladnoy` (NakladnoyListResponse).
 */
export function NakladnoyPage() {
  const { data, isLoading, error, refetch } =
    useApiQuery<NakladnoyListResponse>('/api/nakladnoy');

  const [filter, setFilter] = useState<FilterValue>({});
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const items = useMemo(() => data?.items ?? [], [data]);

  // The endpoint does not exist yet (gap P11): a 404 is expected, not a
  // hard failure. Surface it as an informative empty state rather than an
  // alarming error panel.
  const notImplemented =
    error !== null &&
    /* useApiQuery flattens ApiError to its message, so we re-check the
       known "topilmadi" 404 copy from api-client. */
    /404|topilmadi|mavjud emas/i.test(error);

  // Build a "store" filter from the nakladnoy stores present in the list.
  const filterGroups = useMemo<FilterGroup[]>(() => {
    const byStore = new Map<number, string>();
    for (const n of items) {
      if (n.store_id !== null && n.store_name) {
        byStore.set(n.store_id, n.store_name);
      }
    }
    if (byStore.size === 0) return [];
    return [
      {
        key: 'store',
        label: 'Do‘kon',
        options: [...byStore.entries()].map(([id, name]) => ({
          value: String(id),
          label: name,
        })),
      },
    ];
  }, [items]);

  const rows = useMemo<Nakladnoy[]>(() => {
    const stores = filter['store'] ?? [];
    if (stores.length === 0) return items;
    const set = new Set(stores);
    return items.filter(
      (n) => n.store_id !== null && set.has(String(n.store_id)),
    );
  }, [items, filter]);

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title="Nakladnoylar"
        description="Sotuvdan retsept bo‘yicha avtomatik shakllangan material nakladnoylari (hamir / krem + itogo)."
        dateTime
        filter={
          filterGroups.length > 0 ? (
            <FilterPopover
              groups={filterGroups}
              value={filter}
              onApply={setFilter}
            />
          ) : undefined
        }
      />

      {isLoading && (
        <Card>
          <LoadingState />
        </Card>
      )}

      {!isLoading && error && notImplemented && (
        <Card>
          <EmptyState message="Nakladnoy moduli tayyorlanmoqda — backend kontrakti hali ulanmagan." />
        </Card>
      )}

      {!isLoading && error && !notImplemented && (
        <Card>
          <ErrorState message={error} onRetry={refetch} />
        </Card>
      )}

      {!isLoading && !error && rows.length === 0 && (
        <Card>
          <EmptyState message="Nakladnoylar topilmadi." />
        </Card>
      )}

      {!isLoading && !error && rows.length > 0 && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {rows.map((n) => {
            const isOpen = expandedId === n.id;
            return (
              <div key={n.id} className="space-y-2">
                {isOpen ? (
                  <NakladnoyView nakladnoy={n} />
                ) : (
                  <button
                    type="button"
                    onClick={() => setExpandedId(n.id)}
                    className="flex w-full items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/40 p-4 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">
                        {n.order_qty} × {n.product_name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Nakladnoy #{n.id}
                        {n.store_name && <> · {n.store_name}</>}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-primary">
                      Ko‘rish
                    </span>
                  </button>
                )}
                {isOpen && (
                  <button
                    type="button"
                    onClick={() => setExpandedId(null)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Yashirish
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
