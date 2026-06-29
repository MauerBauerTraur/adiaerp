/**
 * Shared BOM tree component used in both the production order detail page
 * and the new-order form's live preview panel.
 */
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { BomNode } from '@/lib/types';

// ---------------------------------------------------------------------------
// Quantity formatter: kg → г/кг, l → мл/л, pcs → дона
// ---------------------------------------------------------------------------
export function fmtQty(qty: number, unit: string): string {
  if (unit === 'kg') {
    if (qty < 0.001) return `${(qty * 1_000_000).toFixed(1)} мг`;
    if (qty < 1) return `${(qty * 1000).toFixed(qty < 0.01 ? 1 : 0)} г`;
    if (qty < 10) return `${qty.toFixed(3)} кг`;
    return `${qty.toFixed(2)} кг`;
  }
  if (unit === 'l') {
    if (qty < 1) return `${(qty * 1000).toFixed(0)} мл`;
    return `${qty.toFixed(2)} л`;
  }
  const val = qty % 1 === 0 ? qty.toFixed(0) : qty.toFixed(3);
  const label = unit === 'pcs' ? 'дона' : unit;
  return `${val} ${label}`;
}

// ---------------------------------------------------------------------------
// Type display config
// ---------------------------------------------------------------------------
export const TYPE_LABELS: Record<string, string> = {
  raw: 'Xomashyo',
  semi: 'Yarim tayyor',
  finished: 'Tayyor',
};

export const TYPE_CHIP: Record<string, string> = {
  raw: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  semi: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  finished: 'bg-purple-500/15 text-purple-700 dark:text-purple-400',
};

// ---------------------------------------------------------------------------
// Currency formatter (UZS)
// ---------------------------------------------------------------------------
export function fmtCost(amount: number): string {
  const rounded = Math.round(amount);
  return new Intl.NumberFormat('uz-UZ', { maximumFractionDigits: 0 }).format(rounded) + " so'm";
}

// ---------------------------------------------------------------------------
// Recursively sum raw material leaf-node costs (avoids double-counting)
// ---------------------------------------------------------------------------
export function calcTotalCost(nodes: BomNode[]): number | null {
  let total = 0;
  let hasAny = false;
  for (const node of nodes) {
    if (node.children.length === 0) {
      // Leaf (raw material)
      if (node.cost_price != null && node.cost_price > 0) {
        total += node.cost_price * node.qty;
        hasAny = true;
      }
    } else {
      const sub = calcTotalCost(node.children);
      if (sub != null) {
        total += sub;
        hasAny = true;
      }
    }
  }
  return hasAny ? total : null;
}

// ---------------------------------------------------------------------------
// Collect expandable keys (for auto-expand)
// ---------------------------------------------------------------------------
export function collectExpandableKeys(
  nodes: BomNode[],
  depth: number,
  acc: Set<string>,
): void {
  for (const node of nodes) {
    if (node.children.length > 0) {
      acc.add(`${depth}-${node.component_product_id}`);
      collectExpandableKeys(node.children, depth + 1, acc);
    }
  }
}

// ---------------------------------------------------------------------------
// Recursive BOM tree node
// ---------------------------------------------------------------------------
export function BomTreeNode({
  node,
  depth,
  expanded,
  onToggle,
}: {
  node: BomNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (key: string) => void;
}) {
  const key = `${depth}-${node.component_product_id}`;
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(key);
  const showBrutto =
    node.brutto != null &&
    node.brutto > 0 &&
    Math.abs(node.brutto - node.qty) > 0.00001;

  return (
    <>
      <div
        className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/30"
        style={{ paddingLeft: `${8 + depth * 20}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(key)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={isOpen ? 'Yopish' : 'Ochish'}
          >
            {isOpen ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </button>
        ) : (
          <span className="size-3.5 shrink-0" />
        )}

        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
            TYPE_CHIP[node.component_type] ?? 'bg-muted text-muted-foreground'
          }`}
        >
          {TYPE_LABELS[node.component_type] ?? node.component_type}
        </span>

        <span className="min-w-0 flex-1 truncate text-sm">
          {node.component_name}
        </span>

        <span className="shrink-0 text-sm font-semibold tabular-nums">
          {fmtQty(node.qty, node.component_unit)}
        </span>

        {showBrutto && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            ({fmtQty(node.brutto!, node.component_unit)} brutto)
          </span>
        )}

        {node.cost_price != null && node.cost_price > 0 && (
          <span className="shrink-0 text-xs tabular-nums text-amber-600/80 dark:text-amber-400/70">
            ≈ {fmtCost(node.cost_price * node.qty)}
          </span>
        )}
      </div>

      {hasChildren && isOpen && (
        <>
          {node.children.map((child) => (
            <BomTreeNode
              key={`${depth + 1}-${child.component_product_id}`}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
            />
          ))}
        </>
      )}
    </>
  );
}
