import {
  LayoutDashboard,
  Boxes,
  Factory,
  Truck,
  Warehouse,
  Store,
  RefreshCw,
  MapPin,
  Package,
  UserCog,
  ClipboardList,
  ShoppingCart,
  TrendingUp,
  BookOpen,
  Wallet,
  ReceiptText,
  FileText,
  Banknote,
  type LucideIcon,
} from 'lucide-react';
import type { Role } from './types';

/**
 * Hybrid navigation model — F4.13.
 *
 * The sidebar is collapsed to four group icons (Boshqaruv paneli,
 * Bashorat, Modullar, Ma'lumotnoma). Inside the Modullar and
 * Ma'lumotnoma groups, sub-screens appear as Jira-style pill tabs at
 * the top of the page. The group icon is itself a link — clicking it
 * jumps to the group's default screen (or the first screen the user
 * has access to inside that group).
 */
export type NavGroupKey =
  | 'dashboard'
  | 'forecasts'
  | 'modules'
  | 'production-ops'
  | 'reference';

/**
 * Role-scoped navigation. Each item is visible only to the listed roles —
 * derived from the RBAC matrix in docs/specs/phase-1-mvp.md §6.
 */
export interface NavItem {
  /** Route path under the protected layout. */
  path: string;
  /** Uzbek menu label (UI text is Uzbek). */
  label: string;
  icon: LucideIcon;
  /** Roles allowed to see this item. */
  roles: readonly Role[];
}

/** A labelled group of navigation items rendered as one sidebar section. */
export interface NavSection {
  /** Stable key for the group (used for sidebar icons + PageTabs scoping). */
  key: NavGroupKey;
  /** Uzbek section heading (also the group's accessible label). */
  label: string;
  /** Icon shown on the collapsed rail for this group. */
  icon: LucideIcon;
  /**
   * Preferred landing path when the user clicks the group's sidebar
   * icon. If this path is not in `items` (or the user's role can't see
   * it), the first visible item is used as fallback.
   */
  defaultPath: string;
  /**
   * Tabs render inside the page only for groups marked `hasTabs`. The
   * single-screen groups (dashboard, forecasts) do not render PageTabs.
   */
  hasTabs: boolean;
  items: readonly NavItem[];
}

// TZ §3 — every authenticated role plus the AI assistant identity. The
// AI assistant has Read + recommend access chain-wide (same scope as
// PM for queries), so it should see every navigation entry an operator
// would see; the backend RBAC layer is the final gate on writes.
const ALL_ROLES: readonly Role[] = [
  'super_admin',
  'pm',
  'raw_warehouse_manager',
  'production_manager',
  'supply_manager',
  'central_warehouse_manager',
  'store_manager',
  'ai_assistant',
];

const MANAGER_ROLES: readonly Role[] = [
  'super_admin',
  'pm',
  'raw_warehouse_manager',
  'production_manager',
  'supply_manager',
  'central_warehouse_manager',
  'store_manager',
  'ai_assistant',
];

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    key: 'dashboard',
    label: 'Boshqaruv paneli',
    icon: LayoutDashboard,
    defaultPath: '/dashboard',
    hasTabs: false,
    items: [
      {
        path: '/dashboard',
        label: 'Boshqaruv paneli',
        icon: LayoutDashboard,
        roles: ALL_ROLES,
      },
    ],
  },
  {
    key: 'forecasts',
    label: 'Bashorat',
    icon: TrendingUp,
    defaultPath: '/forecasts',
    hasTabs: false,
    items: [
      {
        path: '/forecasts',
        label: 'Bashorat',
        icon: TrendingUp,
        roles: ALL_ROLES,
      },
    ],
  },
  {
    key: 'modules',
    label: 'Modullar',
    icon: Boxes,
    defaultPath: '/raw-warehouse',
    hasTabs: true,
    items: [
      {
        path: '/raw-warehouse',
        label: 'Xom-ashyo ombori',
        icon: Boxes,
        roles: ['super_admin', 'pm', 'raw_warehouse_manager'],
      },
      {
        path: '/production',
        label: 'Ishlab chiqarish',
        icon: Factory,
        roles: ['super_admin', 'pm', 'production_manager'],
      },
      {
        path: '/supply',
        label: 'Sex skladlari',
        icon: Truck,
        roles: ['super_admin', 'pm', 'supply_manager'],
      },
      {
        path: '/central-warehouse',
        label: 'Markaziy sklad',
        icon: Warehouse,
        roles: ['super_admin', 'pm', 'central_warehouse_manager'],
      },
      {
        path: '/stores',
        label: "Do'konlar",
        icon: Store,
        roles: ['super_admin', 'pm', 'store_manager'],
      },
      {
        path: '/replenishment',
        label: "To'ldirish so'rovlari",
        icon: RefreshCw,
        roles: ALL_ROLES,
      },
      {
        // F4.14 — unified inbox/outbox/archive view of every replenishment
        // the user touches. Visible to every role; backend RBAC-scopes
        // the underlying list endpoint.
        path: '/sorovnomalar',
        label: "So'rovnomalar",
        icon: ClipboardList,
        roles: ALL_ROLES,
      },
      {
        path: '/purchase-orders',
        label: "Sotib olish so'rovlari",
        icon: ShoppingCart,
        roles: ['super_admin', 'pm', 'supply_manager', 'raw_warehouse_manager'],
      },
      {
        path: '/poster-supplies',
        label: 'Poster postavkalar',
        icon: Truck,
        roles: ['super_admin', 'pm', 'raw_warehouse_manager'],
      },
      {
        path: '/cashier/receipts',
        label: 'Cheklar',
        icon: ReceiptText,
        roles: ['super_admin', 'pm', 'store_manager'],
      },
      {
        path: '/cashier/shifts',
        label: 'Smenalar',
        icon: Banknote,
        roles: ['super_admin', 'pm', 'store_manager'],
      },
      {
        path: '/cashier/nakladnoy',
        label: 'Nakladnoylar',
        icon: FileText,
        roles: ['super_admin', 'pm', 'store_manager', 'production_manager'],
      },
      {
        path: '/cashier/safe',
        label: 'Seyf rasxodlari',
        icon: Wallet,
        roles: ['super_admin', 'pm'],
      },
    ],
  },
  {
    key: 'production-ops',
    label: 'Ishlab chiqarish',
    icon: Factory,
    defaultPath: '/production-orders',
    hasTabs: true,
    items: [
      {
        path: '/production-orders',
        label: 'Zayavkalar',
        icon: ClipboardList,
        roles: ['super_admin', 'pm', 'production_manager', 'central_warehouse_manager'],
      },
      {
        path: '/warehouse-dispatch',
        label: 'Xomashyo',
        icon: Truck,
        roles: ['super_admin', 'pm', 'raw_warehouse_manager', 'production_manager'],
      },
      {
        path: '/warehouse-dispatch/semi',
        label: 'Yarim tayyor',
        icon: Package,
        roles: ['super_admin', 'pm', 'production_manager'],
      },
      {
        path: '/warehouse-dispatch/finished',
        label: 'Tayyor mahsulot',
        icon: Boxes,
        roles: ['super_admin', 'pm', 'production_manager', 'central_warehouse_manager'],
      },
      {
        path: '/stock-alerts',
        label: 'Stok nazorat',
        icon: RefreshCw,
        roles: ['super_admin', 'pm', 'raw_warehouse_manager', 'production_manager', 'supply_manager', 'central_warehouse_manager'],
      },
    ],
  },
  {
    key: 'reference',
    label: "Ma'lumotnoma",
    icon: BookOpen,
    defaultPath: '/products',
    hasTabs: true,
    items: [
      {
        path: '/products',
        label: 'Mahsulotlar',
        icon: Package,
        roles: MANAGER_ROLES,
      },
      {
        path: '/locations',
        label: "Bo'g'inlar",
        icon: MapPin,
        roles: MANAGER_ROLES,
      },
      {
        // EPIC 3 — "Foydalanuvchilar" va "Hodimlar" bitta sahifaga
        // birlashtirildi (hodim = foydalanuvchi). M:N bo'g'in oqimi +
        // Telegram self-link shu yerda. Eski `/users` → `/employees`
        // redirect (AppRouter).
        path: '/employees',
        label: 'Foydalanuvchilar',
        icon: UserCog,
        roles: ['super_admin', 'pm'],
      },
    ],
  },
];

/**
 * Filter the navigation sections down to those the role may see.
 * Empty sections are dropped.
 */
export function navSectionsForRole(role: Role): NavSection[] {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => item.roles.includes(role)),
  })).filter((section) => section.items.length > 0);
}

/**
 * Resolve the group a route path belongs to. Used by the AppLayout to
 * decide which group's tabs to render at the top of the page (and to
 * highlight the matching sidebar icon).
 *
 * Match is by exact path equality on any item, or by `startsWith` for
 * nested routes (e.g. `/replenishment/:id` → `/replenishment` → modules).
 * Returns `null` for paths outside the nav (e.g. `/admin/import-warnings`).
 */
export function findGroupForPath(pathname: string): NavSection | null {
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      if (
        pathname === item.path ||
        pathname.startsWith(`${item.path}/`)
      ) {
        return section;
      }
    }
  }
  return null;
}

/**
 * Resolve the landing path for a group icon click — the group's
 * `defaultPath` if the role can see it, otherwise the first visible
 * item, otherwise `null` (meaning: the group has no items for this
 * role and its sidebar icon should be hidden).
 */
export function resolveGroupLanding(
  section: NavSection,
  role: Role,
): string | null {
  const visible = section.items.filter((item) => item.roles.includes(role));
  const first = visible[0];
  if (!first) return null;
  const def = visible.find((item) => item.path === section.defaultPath);
  return def ? def.path : first.path;
}
