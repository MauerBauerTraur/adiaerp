/**
 * ADR-0017 — Poster `storage_id` -> ADIA `location_type` mapping.
 *
 * Source of truth: live `storage.getStorages` (2026-05-29 diagnostic),
 * `docs/architecture/adr-0017-poster-storage-classification.md` §3.
 *
 * Why a declarative table: the previous `seedSync.upsertStorage` defaulted
 * ALL 25 Poster storages to `central_warehouse` (P1 bug) — the dashboard
 * "Markaziy sklad" card then swallowed all 25 storages. This mapping fixes
 * the classification at insert time AND makes the rule auditable in one place.
 */

/** ADIA `location_type` values relevant to Poster storage classification. */
export type StorageLocationType =
  | 'raw_warehouse'
  | 'central_warehouse'
  | 'production'
  | 'sex_storage';

/**
 * `storage_id` -> ADIA `location_type` (ADR-0017 §3, the 25 live storages).
 *
 * NOTE the store-backing storages 3/4/5 are INTENTIONALLY OMITTED — they are
 * not standalone locations. They are merged into their POS spot location
 * (P2, see `STORE_BACKING_STORAGE` + `upsertStorage`).
 */
export const STORAGE_TYPE_BY_ID: Readonly<Record<number, StorageLocationType>> = {
  2: 'raw_warehouse', // Основной склад — xom-ashyo ombori
  8: 'central_warehouse', // Склад Центральный — the ONE central warehouse
  20: 'production', // Производственный Цех — ishlab chiqarish floori
  // sex_storage — every remaining classified storage (ADR §3 rows).
  12: 'sex_storage', // Песочный
  15: 'sex_storage', // Самсы
  19: 'sex_storage', // Тортов
  21: 'sex_storage', // Каймок (OQ-1 — safe default)
  25: 'sex_storage', // Тартов
  26: 'sex_storage', // Бисквит
  27: 'sex_storage', // Декора
  28: 'sex_storage', // Спец (OQ-2 — safe default)
  29: 'sex_storage', // Горячих
  30: 'sex_storage', // Тошми (OQ-2 — safe default)
  31: 'sex_storage', // Минор (OQ-2 — safe default)
  32: 'sex_storage', // Наполеон
  33: 'sex_storage', // Салат (OQ-2 — safe default)
  34: 'sex_storage', // Эклеров
  35: 'sex_storage', // Заготовок (zagatovka buferi)
  36: 'sex_storage', // Украшений (ukrasheniye)
  37: 'sex_storage', // Круассанов
  38: 'sex_storage', // Евро
  39: 'sex_storage', // Пирогов
};

/**
 * Store-backing storages -> the POS `spot_id` they belong to (ADR-0017 §4).
 *
 * These storages are NOT inserted as standalone locations. Their
 * `poster_storage_id` is merged onto the matching `type='store'` spot row so
 * that BOTH sales (`poster_spot_id`) and stock (`poster_storage_id`) land on
 * the same single store location.
 */
export const STORE_BACKING_STORAGE: Readonly<Record<number, number>> = {
  3: 1, // Склад Кукча   -> spot 1 Кукча
  4: 2, // Склад Рабочий -> spot 2 Рабочий
  5: 3, // Склад Чигатай -> spot 3 Чигатай
};

/**
 * Safe default for any `storage_id` NOT in `STORAGE_TYPE_BY_ID` — e.g. a NEW
 * storage Poster adds later. `sex_storage` is non-disruptive: an unknown
 * storage never silently becomes central/raw/store. The PM reclassifies via
 * `PATCH /api/locations/:id`.
 */
export const DEFAULT_STORAGE_TYPE: StorageLocationType = 'sex_storage';

/** Resolve the classification for a storage id (default-safe). */
export function classifyStorage(storageId: number): StorageLocationType {
  return STORAGE_TYPE_BY_ID[storageId] ?? DEFAULT_STORAGE_TYPE;
}

/** True when this storage is store-backing and must be merged into a spot. */
export function isStoreBackingStorage(storageId: number): boolean {
  return storageId in STORE_BACKING_STORAGE;
}
