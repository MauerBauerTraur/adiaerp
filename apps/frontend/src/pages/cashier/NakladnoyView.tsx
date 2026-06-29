import { FileText } from 'lucide-react';
import { formatQty, formatDateTime } from '@/lib/format';
import { UNIT_LABELS, NAKLADNOY_SECTION_LABELS } from '@/lib/labels';
import { RECIPE_STAGE_ORDER } from '@/lib/labels';
import type { Nakladnoy } from '@/lib/types';

/**
 * EPIC 8.4 — single nakladnoy view (image19).
 *
 * A "10 Napoleon sotildi" order expands, via the BOM, into ONE nakladnoy
 * split into stacked sections (tepa-past): "Hamir uchun" (un, shakar…),
 * "Krem uchun" (un, shakar…), then an ITOGO roll-up of the total raw
 * material across every section (un, shakar… jami kg). The owner asked
 * for it to be brightly, clearly laid out — so the sections are visually
 * separated and the ITOGO block is emphasized.
 *
 * This is a pure presentational component — it renders an already-built
 * `Nakladnoy` (the parent fetches / supplies it). The backend endpoint
 * that produces this shape is gap P11 (write/derive layer); until it
 * lands the parent feeds fixtures.
 */
export function NakladnoyView({ nakladnoy }: { nakladnoy: Nakladnoy }) {
  // Render sections in the stable BOM order (hamir → krem → bezak → boshqa),
  // dropping stages the nakladnoy has no lines for.
  const sections = RECIPE_STAGE_ORDER.map((stage) =>
    nakladnoy.sections.find((s) => s.stage === stage),
  ).filter((s): s is NonNullable<typeof s> => s !== undefined && s.lines.length > 0);

  return (
    <article
      className="space-y-4 rounded-lg border border-border bg-card/60 p-4 sm:p-5"
      aria-label={`Nakladnoy #${nakladnoy.id}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 pb-3">
        <div className="flex items-start gap-3">
          <span
            className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"
            aria-hidden="true"
          >
            <FileText className="size-5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-base font-semibold tracking-tight">
              {formatQty(nakladnoy.order_qty)} × {nakladnoy.product_name}
            </h3>
            <p className="text-xs text-muted-foreground">
              Nakladnoy #{nakladnoy.id}
              {nakladnoy.store_name && <> · {nakladnoy.store_name}</>}
              {' · '}
              {formatDateTime(nakladnoy.created_at)}
            </p>
          </div>
        </div>
      </header>

      {/* Per-stage sections, stacked top-to-bottom. */}
      <div className="space-y-3">
        {sections.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Bu nakladnoy uchun retsept bo‘limlari topilmadi.
          </p>
        )}
        {sections.map((section) => (
          <section
            key={section.stage}
            className="rounded-md border border-border/50 bg-background/40"
            aria-label={NAKLADNOY_SECTION_LABELS[section.stage]}
          >
            <h4 className="border-b border-border/40 px-3 py-2 text-sm font-semibold text-foreground/90">
              {NAKLADNOY_SECTION_LABELS[section.stage]}
            </h4>
            <ul className="divide-y divide-border/30">
              {section.lines.map((line) => (
                <li
                  key={line.product_id}
                  className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm"
                >
                  <span className="truncate">{line.product_name}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatQty(line.qty)} {UNIT_LABELS[line.unit]}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {/* ITOGO — total raw material across all sections (un, shakar jami). */}
      {nakladnoy.totals.length > 0 && (
        <section
          className="rounded-md border border-primary/30 bg-primary/5 p-3"
          aria-label="Itogo — umumiy materiallar"
        >
          <h4 className="mb-2 text-sm font-semibold uppercase tracking-wide text-primary">
            Itogo (umumiy)
          </h4>
          <ul className="space-y-1">
            {nakladnoy.totals.map((line) => (
              <li
                key={line.product_id}
                className="flex items-center justify-between gap-3 text-sm font-medium"
              >
                <span className="truncate">{line.product_name}</span>
                <span className="shrink-0 tabular-nums">
                  {formatQty(line.qty)} {UNIT_LABELS[line.unit]}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
