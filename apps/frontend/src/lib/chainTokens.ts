/**
 * Chain tone tokens — Sprint A of the Dashboard MEGA Redesign.
 *
 * The supply chain has five logical layers (raw → production → supply →
 * central → store). Every layer carries a semantic colour exposed as Tailwind
 * utilities (`text-chain-raw`, `bg-chain-raw-tint`, …). Both light and dark
 * tokens are defined in `src/index.css`; this module is purely the
 * TypeScript-side map and helper API used by future ChainCard / ChainFlowRow
 * components.
 *
 * Source of truth: `docs/design/dashboard-redesign-plan.md` §2.2.
 */
import type { LocationType } from '@/lib/types';

export type ChainTone =
  | 'raw'
  | 'production'
  | 'supply'
  | 'sex_storage'
  | 'central'
  | 'store';

/**
 * Map a `LocationType` (DB enum) to its chain tone.
 *
 * The "Ta'minot" layer has been renamed to "Sex skladi" — the DB ENUM
 * is migrating from `supply` to `sex_storage`. Both values map to the
 * same chain tone so the canvas/tokens stay stable while the backend
 * rolls forward.
 */
export const CHAIN_TONE_BY_TYPE: Record<LocationType, ChainTone> = {
  raw_warehouse: 'raw',
  production: 'production',
  supply: 'supply',
  sex_storage: 'sex_storage',
  central_warehouse: 'central',
  store: 'store',
};

/** Uzbek display labels for the chain layers. */
export const CHAIN_LABELS: Record<ChainTone, string> = {
  raw: "Xom-ashyo ombori",
  production: "Ishlab chiqarish",
  // Legacy "Ta'minot" — back-compat label; canonical text is "Sex skladi".
  supply: "Sex skladi",
  sex_storage: "Sex skladi",
  central: "Markaziy sklad",
  store: "Do'konlar",
};

/** Tailwind class helpers per tone — for ergonomic JSX composition. */
export const CHAIN_CLASSES: Record<
  ChainTone,
  {
    text: string;
    bg: string;
    bgTint: string;
    border: string;
    ring: string;
  }
> = {
  raw: {
    text: 'text-chain-raw',
    bg: 'bg-chain-raw',
    bgTint: 'bg-chain-raw-tint',
    border: 'border-chain-raw',
    ring: 'ring-chain-raw',
  },
  production: {
    text: 'text-chain-production',
    bg: 'bg-chain-production',
    bgTint: 'bg-chain-production-tint',
    border: 'border-chain-production',
    ring: 'ring-chain-production',
  },
  supply: {
    text: 'text-chain-supply',
    bg: 'bg-chain-supply',
    bgTint: 'bg-chain-supply-tint',
    border: 'border-chain-supply',
    ring: 'ring-chain-supply',
  },
  // `sex_storage` reuses the supply chain tokens — same visual layer,
  // new name. If we ever want a dedicated palette for sex storages,
  // these classnames flip in lockstep with the CSS tokens.
  sex_storage: {
    text: 'text-chain-supply',
    bg: 'bg-chain-supply',
    bgTint: 'bg-chain-supply-tint',
    border: 'border-chain-supply',
    ring: 'ring-chain-supply',
  },
  central: {
    text: 'text-chain-central',
    bg: 'bg-chain-central',
    bgTint: 'bg-chain-central-tint',
    border: 'border-chain-central',
    ring: 'ring-chain-central',
  },
  store: {
    text: 'text-chain-store',
    bg: 'bg-chain-store',
    bgTint: 'bg-chain-store-tint',
    border: 'border-chain-store',
    ring: 'ring-chain-store',
  },
};
