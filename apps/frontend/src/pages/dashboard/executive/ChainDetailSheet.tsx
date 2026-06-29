import type { ComponentType } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Box, Factory, Store, Truck, Warehouse } from 'lucide-react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { CHAIN_CLASSES, CHAIN_LABELS, CHAIN_TONE_BY_TYPE } from '@/lib/chainTokens';
import type { ChainTone } from '@/lib/chainTokens';
import type { LocationType } from '@/lib/types';
import type { DateRangeValue } from '@/components/DateRangeFilter';
import { cn } from '@/lib/utils';
import { RawDetailPanel } from './detail/RawDetailPanel';
import { ProductionDetailPanel } from './detail/ProductionDetailPanel';
import { SupplyDetailPanel } from './detail/SupplyDetailPanel';
import { CentralDetailPanel } from './detail/CentralDetailPanel';
import { StoresDetailPanel } from './detail/StoresDetailPanel';

/**
 * Sprint C — chain detail drawer shell.
 *
 * When a chain card is clicked, `ExecutiveDashboardPage` sets the active
 * chain `type` and this sheet slides in from the right. The header
 * carries a tone-tinted icon and the chain label; the body delegates to
 * the per-stage detail panel, which fetches its own data scoped to the
 * current date range.
 *
 * Accessibility: built on Radix Dialog primitives — focus trap, ESC, and
 * overlay-click come for free. We provide a real `DialogTitle` so screen
 * readers announce the panel.
 */
export interface ChainDetailSheetProps {
  type: LocationType | null;
  range: DateRangeValue;
  onClose(): void;
}

const TYPE_ICON: Record<LocationType, ComponentType<{ className?: string }>> = {
  raw_warehouse: Box,
  production: Factory,
  supply: Truck,
  sex_storage: Truck,
  central_warehouse: Warehouse,
  store: Store,
};

const TITLE_BY_TYPE: Record<LocationType, string> = {
  raw_warehouse: `${CHAIN_LABELS.raw} — batafsil`,
  production: `${CHAIN_LABELS.production} — batafsil`,
  supply: `${CHAIN_LABELS.supply} — batafsil`,
  sex_storage: `${CHAIN_LABELS.sex_storage} — batafsil`,
  central_warehouse: `${CHAIN_LABELS.central} — batafsil`,
  store: `${CHAIN_LABELS.store} — batafsil`,
};

const DESCRIPTION_BY_TYPE: Record<LocationType, string> = {
  raw_warehouse: "Xom-ashyo ombori bo'yicha jonli ko'rsatkichlar.",
  production: "Sexlardagi faollik, yuklamasi va ishlab chiqarish ritmi.",
  supply: "Sex skladi: kirim/chiqim va ochiq so'rovlar.",
  sex_storage: "Sex skladi: kirim/chiqim va ochiq so'rovlar.",
  central_warehouse: "Bloklar, Poster sinx jurnali va sklad qoldiqlari.",
  store: "Do'konlardagi savdo, cheklar va to'ldirish so'rovlari.",
};

export function ChainDetailSheet({
  type,
  range,
  onClose,
}: ChainDetailSheetProps) {
  const open = type !== null;
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="right"
        className={cn(
          'w-full max-w-[540px] overflow-y-auto bg-card sm:max-w-[640px]',
          type !== null && toneSheetClass(CHAIN_TONE_BY_TYPE[type]),
        )}
      >
        {type !== null && (
          <ChainDetailContent type={type} range={range} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function ChainDetailContent({
  type,
  range,
}: {
  type: LocationType;
  range: DateRangeValue;
}) {
  const tone: ChainTone = CHAIN_TONE_BY_TYPE[type];
  const Icon = TYPE_ICON[type];
  const toneCx = CHAIN_CLASSES[tone];

  return (
    <div className="flex h-full flex-col">
      {/* Tone accent strip */}
      <span
        aria-hidden="true"
        className={cn('h-1 w-full', toneCx.bg)}
        data-testid={`chain-detail-accent-${type}`}
      />

      {/* Header */}
      <header
        className="flex items-start gap-3 border-b border-border/60 p-5 pr-12"
        data-testid={`chain-detail-header-${type}`}
      >
        <span
          aria-hidden="true"
          className={cn(
            'inline-flex size-10 shrink-0 items-center justify-center rounded-md',
            toneCx.bgTint,
            toneCx.text,
          )}
        >
          <Icon className="size-5" />
        </span>
        <div className="min-w-0">
          <DialogPrimitive.Title
            className={cn('text-base font-semibold leading-tight', toneCx.text)}
          >
            {TITLE_BY_TYPE[type]}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-1 text-xs text-muted-foreground">
            {DESCRIPTION_BY_TYPE[type]}
          </DialogPrimitive.Description>
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-5">
        {renderPanel(type, range)}
      </div>
    </div>
  );
}

function renderPanel(type: LocationType, range: DateRangeValue) {
  switch (type) {
    case 'raw_warehouse':
      return <RawDetailPanel range={range} />;
    case 'production':
      return <ProductionDetailPanel range={range} />;
    case 'supply':
    case 'sex_storage':
      return <SupplyDetailPanel range={range} />;
    case 'central_warehouse':
      return <CentralDetailPanel range={range} />;
    case 'store':
      return <StoresDetailPanel range={range} />;
  }
}

/**
 * Glow + tone border for the sheet container. Uses the chain glow CSS
 * variable for a soft radial bloom behind the header.
 */
function toneSheetClass(tone: ChainTone): string {
  const glowVar = `--chain-${tone}-glow`;
  // Tailwind cannot generate dynamic var(), so we ship an arbitrary value.
  return `border-l-2 [background-image:radial-gradient(at_100%_0%,hsl(var(${glowVar}))_0%,transparent_55%)]`;
}
