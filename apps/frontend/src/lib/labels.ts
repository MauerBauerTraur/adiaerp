/**
 * Uzbek display labels for domain enum values.
 * UI text is Uzbek (CLAUDE.md §2); enum keys stay English.
 */
import type { DateRangePreset } from '@/components/DateRangeFilter';
import type {
  DashboardAlertType,
  FlowType,
  LocationType,
  MovementReason,
  PosterSyncStatus,
  ProductType,
  ProductionOrderStatus,
  PurchaseOrderStatus,
  RecipeStage,
  ReplenishmentStatus,
  Role,
  Unit,
} from './types';

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Super admin',
  pm: 'PM',
  production_manager: 'Ishlab chiqarish',
  raw_warehouse_manager: 'Sklad',
  supply_manager: "Sex skladi boshlig'i",
  central_warehouse_manager: "Markaziy sklad boshlig'i",
  store_manager: "Do'kon boshlig'i",
  // `ai_assistant` mirrors the backend enum but is not user-facing in
  // Faza-1 — it is intentionally excluded from ROLE_OPTIONS below so it
  // never appears in role pickers.
  ai_assistant: 'AI assistent',
};

export const LOCATION_TYPE_LABELS: Record<LocationType, string> = {
  raw_warehouse: 'Xom-ashyo ombori',
  production: 'Ishlab chiqarish',
  // Legacy "Ta'minot bo'limi" — kept as a back-compat label until the
  // backend ENUM migration finishes; once the API only emits
  // `sex_storage` this entry can be dropped.
  supply: 'Sex skladi',
  sex_storage: 'Sex skladi',
  central_warehouse: 'Markaziy sklad',
  store: "Do'kon",
};

// EPIC 2.1 — oqim (connection) turlari. Admin bo'g'inlar orasidagi oqimni
// shu turlardan biri bilan belgilaydi (location_flows.flow_type).
export const FLOW_TYPE_LABELS: Record<FlowType, string> = {
  production_output: 'Ishlab chiqarish chiqishi',
  bom_input: 'Yarim tayyor qaytishi',
  forward: 'Oldinga oqim',
  reverse: 'Qaytar oqim',
};

export const FLOW_TYPE_OPTIONS: { value: FlowType; label: string }[] = (
  Object.keys(FLOW_TYPE_LABELS) as FlowType[]
).map((value) => ({ value, label: FLOW_TYPE_LABELS[value] }));

export const PRODUCT_TYPE_LABELS: Record<ProductType, string> = {
  raw: 'Xom-ashyo',
  semi: 'Yarim tayyor',
  finished: 'Tayyor mahsulot',
};

export const UNIT_LABELS: Record<Unit, string> = {
  kg: 'kg',
  l: 'l',
  pcs: 'dona',
};

/**
 * EPIC 1.5 — BOM stage section labels for the recipe modal. `other` is the
 * catch-all used when the backend has not (yet) tagged a line with a stage.
 */
export const RECIPE_STAGE_LABELS: Record<RecipeStage, string> = {
  dough: 'Hamir',
  cream: 'Krem',
  decoration: 'Bezak',
  other: 'Boshqa',
};

/** Stable display order of BOM stages in the recipe modal. */
export const RECIPE_STAGE_ORDER: RecipeStage[] = [
  'dough',
  'cream',
  'decoration',
  'other',
];

/**
 * EPIC 8.4 — nakladnoy section headings ("krem uchun", "hamir uchun"…).
 * The owner wants each BOM stage to read as "<stage> uchun" so the
 * nakladnoy is self-describing (image19).
 */
export const NAKLADNOY_SECTION_LABELS: Record<RecipeStage, string> = {
  dough: 'Hamir uchun',
  cream: 'Krem uchun',
  decoration: 'Bezak uchun',
  other: 'Boshqa',
};

/** EPIC 8.5 — kassa smenasi holati. */
export const CASH_SHIFT_STATUS_LABELS: Record<
  import('./types').CashShiftStatus,
  string
> = {
  open: 'Ochiq',
  closed: 'Yopilgan',
};

// ---------------------------------------------------------------------------
// Dashboard date-range copy (EPIC 0.4).
//
// The revenue / receipts KPI titles must follow the selected period filter
// instead of staying frozen on "Bugungi tushum". These maps are the single
// source of truth shared by HeroStrip and RevenueBreakdown so the headline
// wording never drifts between the two widgets.
// ---------------------------------------------------------------------------

/** Revenue card title per period, e.g. `today → "Bugungi tushum"`. */
export const REVENUE_TITLE_BY_RANGE: Record<DateRangePreset, string> = {
  today: 'Bugungi tushum',
  week: 'Bu haftalik tushum',
  month: 'Bu oylik tushum',
  '6m': '6 oylik tushum',
  custom: 'Davr tushumi',
};

/** Receipts card title per period, e.g. `today → "Bugungi sotuvlar"`. */
export const RECEIPTS_TITLE_BY_RANGE: Record<DateRangePreset, string> = {
  today: 'Bugungi sotuvlar',
  week: 'Bu haftalik sotuvlar',
  month: 'Bu oylik sotuvlar',
  '6m': '6 oylik sotuvlar',
  custom: 'Davr sotuvlari',
};

/** Delta-pill comparison caption per period, e.g. `today → "kechaga"`. */
export const COMPARISON_LABEL_BY_RANGE: Record<DateRangePreset, string> = {
  today: 'kechaga',
  week: "o'tgan haftaga",
  month: "o'tgan oyga",
  '6m': 'oldingi 6 oyga',
  custom: 'oldingi davrga',
};

/** Revenue title for an optional range; falls back to "Bugungi tushum". */
export function revenueTitleForRange(range?: DateRangePreset): string {
  return REVENUE_TITLE_BY_RANGE[range ?? 'today'];
}

export const MOVEMENT_REASON_LABELS: Record<MovementReason, string> = {
  sale: 'Savdo',
  production_input: 'Ishlab chiqarishga sarf',
  production_output: 'Ishlab chiqarishdan kirim',
  transfer: "Ko'chirish",
  purchase: 'Sotib olish',
  adjust: "Qo'lda tuzatuv",
};

/**
 * Role picker options for forms. Excludes `ai_assistant` because the AI
 * assistant role is not provisioned by an admin in Faza-1 — its tokens
 * are minted server-side. Order matches the RBAC matrix in §6.
 */
/** Role picker options for user creation/editing forms. Shows the 4 main roles. */
export const ROLE_OPTIONS: { value: Role; label: string }[] = (
  ['super_admin', 'pm', 'production_manager', 'raw_warehouse_manager'] as Role[]
).map((value) => ({ value, label: ROLE_LABELS[value] }));

// `supply` is the legacy synonym of `sex_storage` and would otherwise
// produce a duplicate "Sex skladi" entry in pickers — exclude it from
// the visible option list. The label entry stays so any row arriving
// from the backend with the legacy enum still renders correctly.
export const LOCATION_TYPE_OPTIONS: { value: LocationType; label: string }[] = (
  Object.keys(LOCATION_TYPE_LABELS) as LocationType[]
)
  .filter((value) => value !== 'supply')
  .map((value) => ({ value, label: LOCATION_TYPE_LABELS[value] }));

export const PRODUCT_TYPE_OPTIONS: { value: ProductType; label: string }[] = (
  Object.keys(PRODUCT_TYPE_LABELS) as ProductType[]
).map((value) => ({ value, label: PRODUCT_TYPE_LABELS[value] }));

export const UNIT_OPTIONS: { value: Unit; label: string }[] = (
  Object.keys(UNIT_LABELS) as Unit[]
).map((value) => ({ value, label: UNIT_LABELS[value] }));

// ---------------------------------------------------------------------------
// Sprint 2 — replenishment / production order / purchase order labels.
// ---------------------------------------------------------------------------

/** Uzbek labels for the 10-status replenishment state machine. */
export const REPLENISHMENT_STATUS_LABELS: Record<ReplenishmentStatus, string> = {
  NEW: 'Yangi',
  CHECK_STORE_SUPPLIER: 'Tekshiruv: sex skladi/markaziy sklad',
  SHIP_TO_REQUESTER: "So'rovchiga jo'natish",
  CHECK_PRODUCTION_INPUT: 'Tekshiruv: ishlab chiqarish xom-ashyosi',
  CREATE_PURCHASE_ORDER: "Sotib olish so'rovi",
  CREATE_PRODUCTION_ORDER: 'Ishlab chiqarish zayafkasi',
  PRODUCING: 'Ishlab chiqarilmoqda',
  DONE_TO_WAREHOUSE: 'Markaziy skladga topshirildi',
  CLOSED: 'Yopilgan',
  CANCELLED: 'Bekor qilingan',
};

/** Replenishment status badge variant — visual hierarchy on lists. */
export const REPLENISHMENT_STATUS_VARIANT: Record<
  ReplenishmentStatus,
  'default' | 'outline' | 'success' | 'warning' | 'danger'
> = {
  NEW: 'warning',
  CHECK_STORE_SUPPLIER: 'default',
  SHIP_TO_REQUESTER: 'default',
  CHECK_PRODUCTION_INPUT: 'default',
  CREATE_PURCHASE_ORDER: 'default',
  CREATE_PRODUCTION_ORDER: 'default',
  PRODUCING: 'default',
  DONE_TO_WAREHOUSE: 'default',
  CLOSED: 'success',
  CANCELLED: 'danger',
};

export const REPLENISHMENT_STATUS_OPTIONS: {
  value: ReplenishmentStatus;
  label: string;
}[] = (Object.keys(REPLENISHMENT_STATUS_LABELS) as ReplenishmentStatus[]).map(
  (value) => ({ value, label: REPLENISHMENT_STATUS_LABELS[value] }),
);

/** Uzbek labels for production order statuses. */
export const PRODUCTION_ORDER_STATUS_LABELS: Record<ProductionOrderStatus, string> = {
  new: 'Boshlash',
  in_progress: 'Topshirildi',
  done: 'Qabul qildi',
  cancelled: 'Bekor qilingan',
};

export const PRODUCTION_ORDER_STATUS_VARIANT: Record<
  ProductionOrderStatus,
  'default' | 'outline' | 'success' | 'warning' | 'danger'
> = {
  new: 'warning',
  in_progress: 'default',
  done: 'success',
  cancelled: 'danger',
};

export const PRODUCTION_ORDER_STATUS_OPTIONS: {
  value: ProductionOrderStatus;
  label: string;
}[] = (
  Object.keys(PRODUCTION_ORDER_STATUS_LABELS) as ProductionOrderStatus[]
).map((value) => ({ value, label: PRODUCTION_ORDER_STATUS_LABELS[value] }));

/** Uzbek labels for purchase order statuses. */
export const PURCHASE_ORDER_STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  draft: 'Loyiha',
  approved: 'Tasdiqlangan',
  received: 'Qabul qilingan',
  cancelled: 'Bekor qilingan',
  rejected: 'Rad etilgan',
};

export const PURCHASE_ORDER_STATUS_VARIANT: Record<
  PurchaseOrderStatus,
  'default' | 'outline' | 'success' | 'warning' | 'danger'
> = {
  draft: 'warning',
  approved: 'default',
  received: 'success',
  cancelled: 'danger',
  rejected: 'danger',
};

export const PURCHASE_ORDER_STATUS_OPTIONS: {
  value: PurchaseOrderStatus;
  label: string;
}[] = (
  Object.keys(PURCHASE_ORDER_STATUS_LABELS) as PurchaseOrderStatus[]
).map((value) => ({ value, label: PURCHASE_ORDER_STATUS_LABELS[value] }));

// ---------------------------------------------------------------------------
// Faza-3 F3.2 — AI write-action labels (PendingActionCard).
// Keys match the backend tool registry; unknown keys fall back to the raw
// tool name in the UI (consciously visible, not branded).
// ---------------------------------------------------------------------------

/**
 * Uzbek labels for AI write tools. Each label is short enough to fit on
 * a single line of the PendingActionCard header — emoji is part of the
 * label so the badge reads visually at a glance.
 */
export const ASSISTANT_WRITE_TOOL_LABELS: Record<string, string> = {
  transfer_stock: "🔄 Tovar ko'chirish",
  create_replenishment_request: "📋 Yangi so'rov",
  mark_production_order_done: '✅ Zayafkani yakunlash',
  approve_purchase_order: '👍 Sotib olishni tasdiqlash',
  update_minmax: "✏️ Min/Max o'zgartirish",
  create_production_order: '🏭 Yangi zayafka',
};

/** Lookup helper — falls back to the raw tool name when unmapped. */
export function assistantWriteToolLabel(toolName: string): string {
  return ASSISTANT_WRITE_TOOL_LABELS[toolName] ?? toolName;
}

// ---------------------------------------------------------------------------
// Faza-4 F4.4 — Dashboard ecosystem labels (Poster sync, alerts feed).
// ---------------------------------------------------------------------------

/** Uzbek labels for Poster sync statuses. */
export const POSTER_SYNC_STATUS_LABELS: Record<PosterSyncStatus, string> = {
  ok: 'Muvaffaqiyatli',
  partial: 'Qisman',
  failed: 'Xatolik',
};

/** Badge variant per Poster sync status. */
export const POSTER_SYNC_STATUS_VARIANT: Record<
  PosterSyncStatus,
  'success' | 'warning' | 'danger'
> = {
  ok: 'success',
  partial: 'warning',
  failed: 'danger',
};

/** Uzbek labels for dashboard alert (notification) types. */
export const DASHBOARD_ALERT_TYPE_LABELS: Record<DashboardAlertType, string> = {
  stock_below_min: "Min'dan tushdi",
  replenishment_created: "Yangi to'ldirish so'rovi",
  production_order_created: 'Yangi zayafka',
  production_order_done: 'Zayafka yakunlandi',
  shipment_created: "Jo'natma",
  purchase_request_created: "Sotib olish so'rovi",
  purchase_request_approved: 'Sotib olish tasdiqlandi',
  poster_sync_failed: 'Poster sync xato',
  negative_stock_detected: 'Manfiy qoldiq',
};

/** Lookup helper — falls back to the raw type string when unmapped. */
export function dashboardAlertTypeLabel(type: string): string {
  return (
    DASHBOARD_ALERT_TYPE_LABELS[type as DashboardAlertType] ?? type
  );
}
