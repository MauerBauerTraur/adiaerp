import { useMemo, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { Card } from '@/components/ui/card';
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
import type {
  ForecastItem,
  ForecastsResponse,
  Location,
  Product,
  ProductType,
} from '@/lib/types';
import { PRODUCT_TYPE_LABELS, UNIT_LABELS } from '@/lib/labels';
import { formatDateTime } from '@/lib/format';
import { ForecastDetailDialog } from './ForecastDetailDialog';

type ProductTypeFilter = ProductType | 'all';
type LocationFilter = number | 'all';

const PRODUCT_TYPE_FILTER_OPTIONS: {
  value: ProductTypeFilter;
  label: string;
}[] = [
  { value: 'all', label: 'Barchasi' },
  { value: 'raw', label: PRODUCT_TYPE_LABELS.raw },
  { value: 'semi', label: PRODUCT_TYPE_LABELS.semi },
  { value: 'finished', label: PRODUCT_TYPE_LABELS.finished },
];

/**
 * F3.4 — full forecasts table (phase-3.md §2.4, ADR-0010).
 *
 * RBAC-scoped by the backend (`/api/forecasts` filters by the caller's
 * role/location). The page surfaces every row, with location +
 * product-type filters. Clicking a row opens a detail dialog with the
 * 14-day chart and confidence bounds.
 */
export function ForecastsPage() {
  const forecasts = useApiQuery<ForecastsResponse>('/api/forecasts');
  // Auxiliary fetches power the filter dropdowns. They are cheap (list
  // endpoints) and let the page work without forecast-side joins.
  const locations = useApiQuery<Location[]>('/api/locations');
  const products = useApiQuery<Product[]>('/api/products');

  const [locationFilter, setLocationFilter] = useState<LocationFilter>('all');
  const [typeFilter, setTypeFilter] = useState<ProductTypeFilter>('all');
  const [selected, setSelected] = useState<ForecastItem | null>(null);

  const productTypeById = useMemo(() => {
    const map = new Map<number, ProductType>();
    for (const p of products.data ?? []) map.set(p.id, p.type);
    return map;
  }, [products.data]);

  const filtered = useMemo(() => {
    const items = forecasts.data?.items ?? [];
    return items.filter((f) => {
      if (locationFilter !== 'all' && f.location_id !== locationFilter) {
        return false;
      }
      if (typeFilter !== 'all') {
        const type = productTypeById.get(f.product_id);
        if (type !== typeFilter) return false;
      }
      return true;
    });
  }, [forecasts.data, locationFilter, typeFilter, productTypeById]);

  const isLoading = forecasts.isLoading && forecasts.data === null;

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title="Bashorat"
        description="Keyingi 14 kunlik sotuv bashorati (Prophet)."
      />

      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:gap-4">
        <div className="space-y-1">
          <Label htmlFor="forecast-location">Bo‘g‘in</Label>
          <Select
            id="forecast-location"
            className="w-full sm:w-56"
            value={String(locationFilter)}
            onChange={(e) => {
              const v = e.target.value;
              setLocationFilter(v === 'all' ? 'all' : Number(v));
            }}
          >
            <option value="all">Barchasi</option>
            {(locations.data ?? []).map((l) => (
              <option key={l.id} value={String(l.id)}>
                {l.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="forecast-type">Mahsulot turi</Label>
          <Select
            id="forecast-type"
            className="w-52"
            value={typeFilter}
            onChange={(e) =>
              setTypeFilter(e.target.value as ProductTypeFilter)
            }
          >
            {PRODUCT_TYPE_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <Card>
        {isLoading && <LoadingState />}
        {forecasts.error && forecasts.data === null && (
          <ErrorState message={forecasts.error} onRetry={forecasts.refetch} />
        )}
        {forecasts.data !== null && filtered.length === 0 && (
          <EmptyState message="Bashorat ma’lumotlari topilmadi." />
        )}
        {forecasts.data !== null && filtered.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mahsulot</TableHead>
                  <TableHead>Bo‘g‘in</TableHead>
                  <TableHead className="text-right">Birlik</TableHead>
                  <TableHead>Tugash sanasi</TableHead>
                  <TableHead>Yangilangan</TableHead>
                  <TableHead aria-label="Holat" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((f) => (
                  <TableRow
                    key={`${f.location_id}-${f.product_id}`}
                    className="cursor-pointer hover:bg-muted/40"
                    onClick={() => setSelected(f)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelected(f);
                      }
                    }}
                    data-testid="forecast-row"
                  >
                    <TableCell className="font-medium">
                      {f.product_name}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {f.location_name}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {UNIT_LABELS[f.product_unit]}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {f.expected_stockout_date ?? (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {formatDateTime(f.generated_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      {f.stale && (
                        <Badge variant="warning" className="gap-1">
                          <AlertCircle
                            className="size-3"
                            aria-hidden="true"
                          />
                          Eski
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      <ForecastDetailDialog
        forecast={selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      />
    </div>
  );
}
