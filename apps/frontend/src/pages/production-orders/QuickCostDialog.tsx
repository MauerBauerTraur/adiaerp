import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, X, Calculator } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useApiQuery } from '@/hooks/useApiQuery';
import { UNIT_LABELS } from '@/lib/labels';
import type { Product } from '@/lib/types';

interface QuickRow {
  id: number;
  productId: string;
  qty: string;
}

function RawCombobox({
  options,
  value,
  onChange,
}: {
  options: Product[];
  value: string;
  onChange: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');

  const selectedName = options.find((p) => String(p.id) === value)?.name ?? '';

  const filtered = useMemo(() => {
    const lq = q.toLowerCase();
    return lq ? options.filter((p) => p.name.toLowerCase().includes(lq)) : options;
  }, [options, q]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setQ('');
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  return (
    <div ref={ref} className="relative flex-1 min-w-0">
      <input
        type="text"
        value={open ? q : selectedName}
        placeholder="Mahsulot tanlang…"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
      />
      {open && filtered.length > 0 && (
        <ul className="absolute z-50 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-border bg-popover shadow-md text-sm">
          {filtered.slice(0, 50).map((p) => (
            <li
              key={p.id}
              className="cursor-pointer px-3 py-1.5 hover:bg-accent"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(String(p.id));
                setQ('');
                setOpen(false);
              }}
            >
              {p.name}
              {p.unit && (
                <span className="ml-1 text-xs text-muted-foreground">
                  ({(UNIT_LABELS as Record<string, string>)[p.unit] ?? p.unit})
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

let nextId = 1;

interface Props {
  open: boolean;
  onClose: () => void;
}

export function QuickCostDialog({ open, onClose }: Props) {
  const [productName, setProductName] = useState('');
  const [rows, setRows] = useState<QuickRow[]>([{ id: nextId++, productId: '', qty: '' }]);

  const { data: allProducts } = useApiQuery<Product[]>('/api/products');
  const products = useMemo(
    () => (allProducts ?? []).filter((p) => p.is_active),
    [allProducts],
  );

  function addRow() {
    setRows((r) => [...r, { id: nextId++, productId: '', qty: '' }]);
  }

  function removeRow(id: number) {
    setRows((r) => r.filter((row) => row.id !== id));
  }

  function setRowProduct(id: number, productId: string) {
    setRows((r) => r.map((row) => (row.id === id ? { ...row, productId } : row)));
  }

  function setRowQty(id: number, qty: string) {
    setRows((r) => r.map((row) => (row.id === id ? { ...row, qty } : row)));
  }

  function handleClose() {
    setProductName('');
    setRows([{ id: nextId++, productId: '', qty: '' }]);
    onClose();
  }

  const enriched = rows.map((row) => {
    const product = products.find((p) => String(p.id) === row.productId);
    const parsedQty = parseFloat(row.qty);
    const costPrice = product?.cost_price ?? null;
    const lineTotal = product && costPrice != null && !isNaN(parsedQty) ? parsedQty * costPrice : null;
    return { ...row, product, costPrice, lineTotal };
  });

  const totalCost = enriched.reduce((s, r) => s + (r.lineTotal ?? 0), 0);
  const hasAny = enriched.some((r) => r.lineTotal != null);

  function handlePrint() {
    const lines = enriched
      .filter((r) => r.product && r.qty != null)
      .map(
        (r) =>
          `  ${r.product!.name}: ${r.qty} ${(UNIT_LABELS as Record<string, string>)[r.product!.unit] ?? r.product!.unit}` +
          (r.lineTotal != null
            ? ` × ${r.costPrice?.toLocaleString('uz-UZ')} = ${r.lineTotal.toLocaleString('uz-UZ', { maximumFractionDigits: 0 })} so'm`
            : ''),
      )
      .join('\n');
    const text = `Mahsulot: ${productName || '(nomsiz)'}\n\nXomashyolar:\n${lines}\n\nJami xomashyo narxi: ${totalCost.toLocaleString('uz-UZ', { maximumFractionDigits: 0 })} so'm`;
    const w = window.open('', '_blank');
    if (w) {
      w.document.write(`<pre style="font-family:monospace;font-size:14px;padding:24px">${text}</pre>`);
      w.print();
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Calculator className="size-4" />
            Xomashyo narxini hisoblash
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Product name */}
          <div className="space-y-1">
            <Label htmlFor="qc-name">Mahsulot nomi (vaqtinchalik)</Label>
            <Input
              id="qc-name"
              placeholder="Masalan: Yangi tort"
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
            />
          </div>

          {/* Ingredient rows */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Xomashyolar</p>
            {enriched.map((row) => (
              <div key={row.id} className="flex items-center gap-2">
                <RawCombobox
                  options={products}
                  value={row.productId}
                  onChange={(id) => setRowProduct(row.id, id)}
                />
                <input
                  type="number"
                  min="0"
                  step="any"
                  placeholder="Miqdor"
                  value={row.qty}
                  onChange={(e) => setRowQty(row.id, e.target.value)}
                  className="w-24 shrink-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-1 focus:ring-primary"
                />
                {row.product && (
                  <span className="w-10 shrink-0 text-xs text-muted-foreground">
                    {(UNIT_LABELS as Record<string, string>)[row.product.unit] ?? row.product.unit}
                  </span>
                )}
                {row.lineTotal != null ? (
                  <span className="w-28 shrink-0 text-right text-sm font-medium tabular-nums">
                    {row.lineTotal.toLocaleString('uz-UZ', { maximumFractionDigits: 0 })}
                  </span>
                ) : (
                  <span className="w-28 shrink-0" />
                )}
                <button
                  type="button"
                  onClick={() => removeRow(row.id)}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
            <Button type="button" variant="ghost" size="sm" onClick={addRow} className="gap-1.5">
              <Plus className="size-3.5" />
              Qator qo'shish
            </Button>
          </div>

          {/* Total */}
          {hasAny && (
            <div className="rounded-xl border border-border bg-muted/30 px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Jami xomashyo narxi</span>
                <span className="text-lg font-bold tabular-nums">
                  {totalCost.toLocaleString('uz-UZ', { maximumFractionDigits: 0 })}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">so'm</span>
                </span>
              </div>
              {enriched.some((r) => r.product && r.costPrice == null) && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  * Ba'zi mahsulotlarning narxi kiritilmagan — ular hisobga olinmadi.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-between gap-2 border-t border-border pt-4">
          <Button type="button" variant="outline" onClick={handlePrint} disabled={!hasAny}>
            Chop etish
          </Button>
          <Button type="button" variant="ghost" onClick={handleClose}>
            <X className="size-4" />
            Yopish
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
