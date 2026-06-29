import { Routes, Route, Navigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { ProtectedRoute } from './ProtectedRoute';
import { RoleRoute } from './RoleRoute';
import { LoginPage } from '@/pages/LoginPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { LocationsPage } from '@/pages/locations/LocationsPage';
import { LocationDetailPage } from '@/pages/locations/LocationDetailPage';
import { EmployeesPage } from '@/pages/employees/EmployeesPage';
import { ProductsPage } from '@/pages/products/ProductsPage';
import { StockPage } from '@/pages/stock/StockPage';
import { ReplenishmentPage } from '@/pages/replenishment/ReplenishmentPage';
import { ReplenishmentDetailPage } from '@/pages/replenishment/ReplenishmentDetailPage';
import { RequestsPage } from '@/pages/requests/RequestsPage';
import { ProductionOrdersPage } from '@/pages/production-orders/ProductionOrdersPage';
import { ProductionOrderDetailPage } from '@/pages/production-orders/ProductionOrderDetailPage';
import { WarehouseDispatchPage } from '@/pages/production-orders/WarehouseDispatchPage';
import { StockAlertsPage } from '@/pages/products/StockAlertsPage';
import { PurchaseOrdersPage } from '@/pages/purchase-orders/PurchaseOrdersPage';
import { DashboardPage } from '@/pages/dashboard/DashboardPage';
import { ExecutiveDashboardPage } from '@/pages/dashboard/executive/ExecutiveDashboardPage';
import { ForecastsPage } from '@/pages/forecasts/ForecastsPage';
import { ImportWarningsPage } from '@/pages/admin/ImportWarningsPage';
import { RawWarehousePage } from '@/pages/chain/RawWarehousePage';
import { ProductionPage } from '@/pages/chain/ProductionPage';
import { SupplyPage } from '@/pages/chain/SupplyPage';
import { CentralWarehousePage } from '@/pages/chain/CentralWarehousePage';
import { StoresPage } from '@/pages/chain/StoresPage';
import { ReceiptsPage } from '@/pages/cashier/ReceiptsPage';
import { CashShiftsPage } from '@/pages/cashier/CashShiftsPage';
import { SafeExpensesPage } from '@/pages/cashier/SafeExpensesPage';
import { NakladnoyPage } from '@/pages/cashier/NakladnoyPage';
import { PosterSuppliesPage } from '@/pages/poster-supplies/PosterSuppliesPage';

/**
 * Application routes (phase-1-mvp.md §2, §6).
 *
 * Faza-1 Sprint 1 delivers M1 (locations/users), M2 (products/recipes)
 * and M3 (stock). The warehouse / store module screens reuse StockPage —
 * the backend scopes /api/stock by role, so each manager sees only their
 * own location. Dashboard, production, supply and replenishment remain
 * placeholders until their sprints.
 */
export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />

        {/* F4.7 — Executive (boshliq) dashboard at /dashboard; the
            full operations view is parked at /dashboard/operations so
            existing deep links stay live. */}
        <Route path="/dashboard" element={<ExecutiveDashboardPage />} />
        <Route path="/dashboard/operations" element={<DashboardPage />} />
        {/* Ekosistema canvas → per-location detail (header + KPI + stock +
            recent movements + open requests + manager info). Backend RBAC
            scopes the underlying endpoints; a scoped manager hitting a
            location outside their scope will receive 403 from /api/locations
            and the page surfaces an ErrorState. */}
        <Route
          path="/dashboard/locations/:locationId"
          element={<LocationDetailPage />}
        />

        {/* F3.4 — Forecasts page (all authenticated roles, RBAC-scoped server-side). */}
        <Route path="/forecasts" element={<ForecastsPage />} />

        {/* F4.6 — chain-layer module screens. Each composes the shared
            ChainLayerLayout; the backend scopes the chain-layer
            endpoint by the caller's role and active location. The
            generic StockPage stays available at /stock. */}
        <Route
          path="/raw-warehouse"
          element={
            <RoleRoute allow={['super_admin', 'pm', 'raw_warehouse_manager']}>
              <RawWarehousePage />
            </RoleRoute>
          }
        />
        <Route
          path="/production"
          element={
            <RoleRoute allow={['super_admin', 'pm', 'production_manager']}>
              <ProductionPage />
            </RoleRoute>
          }
        />
        <Route
          path="/supply"
          element={
            <RoleRoute allow={['super_admin', 'pm', 'supply_manager']}>
              <SupplyPage />
            </RoleRoute>
          }
        />
        <Route
          path="/central-warehouse"
          element={
            <RoleRoute allow={['super_admin', 'pm', 'central_warehouse_manager']}>
              <CentralWarehousePage />
            </RoleRoute>
          }
        />
        <Route
          path="/stores"
          element={
            <RoleRoute
              allow={['super_admin', 'pm', 'store_manager', 'central_warehouse_manager']}
            >
              <StoresPage />
            </RoleRoute>
          }
        />

        {/* Generic stock screen (PM debug / cross-layer view). */}
        <Route
          path="/stock"
          element={
            <StockPage
              title="Ombor qoldig‘i"
              description="Butun zanjir bo‘yicha qoldiq va harakatlar."
            />
          }
        />

        <Route path="/replenishment" element={<ReplenishmentPage />} />
        <Route
          path="/replenishment/:id"
          element={<ReplenishmentDetailPage />}
        />

        {/* F4.14 — unified inbox/outbox/archive ("So'rovnomalar"). */}
        <Route path="/sorovnomalar" element={<RequestsPage />} />

        {/* EPIC 4.3 — "Yetkazib berish" (delivery) module removed; sections
            send directly and receive on arrival. Old bookmarks redirect to
            the unified requests inbox. */}
        <Route
          path="/delivery"
          element={<Navigate to="/sorovnomalar" replace />}
        />

        <Route
          path="/production-orders"
          element={
            <RoleRoute
              allow={[
                'super_admin',
                'pm',
                'production_manager',
                'central_warehouse_manager',
              ]}
            >
              <ProductionOrdersPage />
            </RoleRoute>
          }
        />
        <Route
          path="/production-orders/:id"
          element={
            <RoleRoute
              allow={[
                'super_admin',
                'pm',
                'production_manager',
                'central_warehouse_manager',
                'raw_warehouse_manager',
              ]}
            >
              <ProductionOrderDetailPage />
            </RoleRoute>
          }
        />
        <Route
          path="/warehouse-dispatch"
          element={
            <RoleRoute allow={['super_admin', 'pm', 'raw_warehouse_manager', 'production_manager']}>
              <WarehouseDispatchPage productTypeFilter="raw" />
            </RoleRoute>
          }
        />
        <Route
          path="/warehouse-dispatch/semi"
          element={
            <RoleRoute allow={['super_admin', 'pm', 'production_manager']}>
              <WarehouseDispatchPage productTypeFilter="semi" />
            </RoleRoute>
          }
        />
        <Route
          path="/warehouse-dispatch/finished"
          element={
            <RoleRoute allow={['super_admin', 'pm', 'production_manager', 'central_warehouse_manager']}>
              <WarehouseDispatchPage productTypeFilter="finished" />
            </RoleRoute>
          }
        />
        <Route
          path="/stock-alerts"
          element={
            <RoleRoute allow={['super_admin', 'pm', 'raw_warehouse_manager', 'production_manager', 'supply_manager', 'central_warehouse_manager']}>
              <StockAlertsPage />
            </RoleRoute>
          }
        />
        <Route
          path="/purchase-orders"
          element={
            <RoleRoute
              allow={[
                'super_admin',
                'pm',
                'supply_manager',
                'raw_warehouse_manager',
              ]}
            >
              <PurchaseOrdersPage />
            </RoleRoute>
          }
        />

        {/* EPIC 8 — Kassa / chek & nakladnoy. PM (chain-wide read) +
            store_manager (own store, RBAC-scoped server-side). The cash
            shift / safe / nakladnoy backend contracts are not wired yet
            (gaps P8/P10/P11); the pages degrade to an informative empty
            state on a 404. */}
        <Route
          path="/cashier/receipts"
          element={
            <RoleRoute allow={['super_admin', 'pm', 'store_manager']}>
              <ReceiptsPage />
            </RoleRoute>
          }
        />
        <Route
          path="/cashier/shifts"
          element={
            <RoleRoute allow={['super_admin', 'pm', 'store_manager']}>
              <CashShiftsPage />
            </RoleRoute>
          }
        />
        <Route
          path="/cashier/nakladnoy"
          element={
            <RoleRoute
              allow={['super_admin', 'pm', 'store_manager', 'production_manager']}
            >
              <NakladnoyPage />
            </RoleRoute>
          }
        />
        <Route
          path="/cashier/safe"
          element={
            <RoleRoute allow={['super_admin', 'pm']}>
              <SafeExpensesPage />
            </RoleRoute>
          }
        />

        {/* M10 — Poster Поставки (supply deliveries) — raw_warehouse_manager + pm + super_admin. */}
        <Route
          path="/poster-supplies"
          element={
            <RoleRoute allow={['super_admin', 'pm', 'raw_warehouse_manager']}>
              <PosterSuppliesPage />
            </RoleRoute>
          }
        />

        {/* M2 — products & recipes. */}
        <Route path="/products" element={<ProductsPage />} />

        {/* M1 — locations. */}
        <Route path="/locations" element={<LocationsPage />} />

        {/* EPIC 3 — "Foydalanuvchilar" va "Hodimlar" bitta sahifaga
            birlashtirildi (hodim = foydalanuvchi). Eski `/users`
            bookmarklar yangi birlashtirilgan sahifaga yo'naltiriladi. */}
        <Route path="/users" element={<Navigate to="/employees" replace />} />
        <Route
          path="/employees"
          element={
            <RoleRoute allow={['super_admin', 'pm']}>
              <EmployeesPage />
            </RoleRoute>
          }
        />

        {/* Faza-2 F2.3 — PM-only import-warnings admin panel. */}
        <Route
          path="/admin/import-warnings"
          element={
            <RoleRoute allow={['super_admin', 'pm']}>
              <ImportWarningsPage />
            </RoleRoute>
          }
        />
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
