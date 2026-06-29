import { useId } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ClipboardCheck, ClipboardList, ShoppingCart } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { formatQty, formatRelative } from '@/lib/format';
import type { PurchaseOrder, ReplenishmentRequest } from '@/lib/types';
import { cn } from '@/lib/utils';

const TOP_LIMIT = 5;

type ActionType = 'po' | 'rep';

interface ActionRow {
  key: string;
  label: string;
  sub: string;
  href: string;
  cta: string;
  type: ActionType;
}

function buildRows(purchaseOrders: PurchaseOrder[], replenishments: ReplenishmentRequest[]): ActionRow[] {
  const rows: ActionRow[] = [];
  for (const po of purchaseOrders) {
    if (po.status !== 'draft') continue;
    rows.push({
      key: `po-${po.id}`,
      type: 'po',
      label: po.product_name,
      sub: `${po.target_location_name} · ${formatQty(po.qty)} · ${formatRelative(po.created_at)}`,
      href: '/purchase-orders',
      cta: 'Tasdiqlash',
    });
  }
  for (const r of replenishments) {
    if (r.status !== 'NEW') continue;
    rows.push({
      key: `rep-${r.id}`,
      type: 'rep',
      label: r.product_name,
      sub: `${r.requester_location_name} · ${formatQty(r.qty_needed)} · ${formatRelative(r.created_at)}`,
      href: `/replenishment/${r.id}`,
      cta: "Ko'rish",
    });
  }
  return rows;
}

const TYPE_CFG: Record<ActionType, {
  dot: string;
  chipBg: string;
  chipText: string;
  headerBg: string;
  headerText: string;
  Icon: typeof ShoppingCart;
  label: string;
}> = {
  po: {
    dot: 'bg-amber-400',
    chipBg: 'bg-amber-500/15',
    chipText: 'text-amber-700 dark:text-amber-400',
    headerBg: 'bg-amber-500/10',
    headerText: 'text-amber-700 dark:text-amber-400',
    Icon: ShoppingCart,
    label: 'Sotib olish',
  },
  rep: {
    dot: 'bg-sky-400',
    chipBg: 'bg-sky-500/15',
    chipText: 'text-sky-700 dark:text-sky-400',
    headerBg: 'bg-sky-500/10',
    headerText: 'text-sky-700 dark:text-sky-400',
    Icon: ClipboardList,
    label: "To'ldirish so'rovi",
  },
};

export function MyActionsList({
  purchaseOrders,
  replenishments,
  className,
}: {
  purchaseOrders: PurchaseOrder[];
  replenishments: ReplenishmentRequest[];
  className?: string;
}) {
  const rows = buildRows(purchaseOrders, replenishments);
  const top = rows.slice(0, TOP_LIMIT);
  const overflow = rows.length - top.length;
  const headingId = useId();
  const total = rows.length;

  return (
    <Card
      className={cn(
        'flex flex-col overflow-hidden',
        total > 0 && 'border-amber-500/25',
        className,
      )}
      data-testid="my-actions-list"
      role="region"
      aria-labelledby={headingId}
    >
      {/* Header */}
      <header
        className={cn(
          'flex items-center justify-between gap-3 border-b p-5',
          total > 0
            ? 'border-amber-500/20 bg-gradient-to-br from-amber-500/10 to-amber-500/3'
            : 'border-border/60',
        )}
      >
        <div className="flex items-center gap-3">
          <div className={cn(
            'flex size-9 items-center justify-center rounded-xl',
            total > 0 ? 'bg-amber-500/15' : 'bg-primary/10',
          )}>
            {total > 0 ? (
              <ClipboardList className="size-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            ) : (
              <ClipboardCheck className="size-4 text-primary" aria-hidden="true" />
            )}
          </div>
          <div>
            <h2 id={headingId} className="text-sm font-bold leading-tight">
              Mendan kutilmoqda
            </h2>
            <p className="text-[11px] text-muted-foreground">
              {total > 0 ? `${total} ta tasdiq talab qiluvchi so'rov` : 'Barcha so\'rovlar hal qilindi'}
            </p>
          </div>
        </div>
        {total > 0 && (
          <span className="inline-flex min-w-[2rem] items-center justify-center rounded-full bg-amber-500 px-2 py-0.5 text-xs font-bold tabular-nums text-white shadow-sm">
            {formatQty(total)}
          </span>
        )}
      </header>

      {/* Content */}
      {rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <ClipboardCheck className="size-9 text-primary/30" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">
            Hozirda harakat talab qilinmaydi.
          </p>
        </div>
      ) : (
        <ol className="flex-1 divide-y divide-border/40">
          {top.map((row) => {
            const cfg = TYPE_CFG[row.type];
            const { Icon } = cfg;
            return (
              <li key={row.key}>
                <Link
                  to={row.href}
                  className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  {/* Type badge */}
                  <div className={cn('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md', cfg.chipBg)}>
                    <Icon className={cn('size-3', cfg.chipText)} aria-hidden="true" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="truncate text-[13px] font-semibold text-foreground group-hover:text-primary">
                        {row.label}
                      </p>
                      <span className={cn('shrink-0 rounded-md px-2 py-0.5 text-[10px] font-bold', cfg.chipBg, cfg.chipText)}>
                        {row.cta}
                        <ArrowRight className="ml-0.5 inline size-2.5" />
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {row.sub}
                    </p>
                  </div>
                </Link>
              </li>
            );
          })}
        </ol>
      )}

      {overflow > 0 && (
        <footer className="border-t border-border/60 px-5 py-2.5 text-center">
          <Link to="/purchase-orders" className="text-xs font-semibold text-primary hover:underline">
            Yana {formatQty(overflow)} ta →
          </Link>
        </footer>
      )}
    </Card>
  );
}
