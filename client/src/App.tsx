import { Navigate, Route, Routes } from "react-router-dom";
import { AppSidebar } from "./components/layout/AppSidebar";
import { MobileNavDrawer } from "./components/layout/MobileNavDrawer";
import { AppDisplayPreferencesBar } from "./components/layout/AppDisplayPreferencesBar";
import { MarketTickerPanel } from "./components/layout/MarketTickerPanel";
import { DisplayPreferencesProvider, useDisplayPreferences } from "./context/DisplayPreferencesContext";
import { AccountDetailPage } from "./pages/AccountDetailPage";
import { CreditCardsPage } from "./pages/CreditCardsPage";
import { GroupInfoPage } from "./pages/GroupInfoPage";
import { LiabilitiesGroupPage } from "./pages/LiabilitiesGroupPage";
import { DashboardPage } from "./pages/DashboardPage";
import { DepositsPage } from "./pages/DepositsPage";
import { DepositsReconciliationPage } from "./pages/DepositsReconciliationPage";
import { ExpensesPage } from "./pages/ExpensesPage";
import { RealEstateExpensesPage } from "./pages/RealEstateExpensesPage";
import { FlowsLayout } from "./pages/FlowsLayout";
import { IncomePage } from "./pages/IncomePage";
import { ControlPanelLayout } from "./pages/panel/ControlPanelLayout";
import { AccountsPanelPage } from "./pages/panel/AccountsPanelPage";
import { ImportSyncPage } from "./pages/panel/ImportSyncPage";
import { NotificationsPage } from "./pages/panel/NotificationsPage";
import { RatesPage } from "./pages/RatesPage";
import { WatchlistPage } from "./pages/WatchlistPage";

export default function App() {
  return (
    <DisplayPreferencesProvider>
      <AppTree />
    </DisplayPreferencesProvider>
  );
}

/**
 * The whole tree lives inside a context consumer: a display-preference change
 * (e.g. decimal separator) re-renders it top-down, so plain format helpers
 * re-run everywhere without remounting anything (no loading flash, state kept).
 */
function AppTree() {
  useDisplayPreferences();
  return (
    <div className="layout layout--with-sidebar">
        <MobileNavDrawer>
          <AppSidebar />
        </MobileNavDrawer>
        <MarketTickerPanel />
        <div className="layout-main">
          <AppDisplayPreferencesBar />
          <div className="content">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/inversiones/*" element={<GroupInfoPage />} />
            <Route path="/retirement" element={<Navigate to="/inversiones/retiro" replace />} />
            <Route path="/retirement/*" element={<Navigate to="/inversiones/retiro" replace />} />
            <Route path="/brokerage" element={<Navigate to="/inversiones/brokerage" replace />} />
            <Route path="/brokerage/*" element={<Navigate to="/inversiones/brokerage" replace />} />
            <Route path="/cash_eqs/*" element={<GroupInfoPage />} />
            <Route path="/crypto" element={<Navigate to="/inversiones/brokerage/crypto" replace />} />
            <Route path="/real_estate" element={<GroupInfoPage />} />
            <Route path="/credit-cards" element={<CreditCardsPage />} />
            <Route path="/liabilities" element={<LiabilitiesGroupPage />} />
            <Route path="/liabilities/:subgroup/:issuer" element={<LiabilitiesGroupPage />} />
            <Route path="/liabilities/:subgroup" element={<LiabilitiesGroupPage />} />
            <Route path="/flows" element={<FlowsLayout />}>
              <Route index element={<Navigate to="income" replace />} />
              <Route path="income" element={<IncomePage />} />
              <Route path="expenses" element={<ExpensesPage />} />
              <Route path="expenses/real_estate" element={<RealEstateExpensesPage />} />
              <Route path="expenses/real_estate/:accountSlug" element={<RealEstateExpensesPage />} />
              <Route path="deposits" element={<DepositsPage />} />
              <Route path="deposits/reconciliation" element={<DepositsReconciliationPage />} />
            </Route>
            <Route path="/rates" element={<RatesPage />} />
            <Route path="/watchlist" element={<WatchlistPage />} />
            <Route path="/panel" element={<ControlPanelLayout />}>
              <Route index element={<Navigate to="notifications" replace />} />
              <Route path="notifications" element={<NotificationsPage />} />
              <Route path="accounts" element={<AccountsPanelPage />} />
              <Route path="import-sync" element={<ImportSyncPage />} />
            </Route>
            <Route path="/messages" element={<Navigate to="/panel/notifications" replace />} />
            <Route path="/income" element={<Navigate to="/flows/income" replace />} />
            <Route path="/expenses" element={<Navigate to="/flows/expenses" replace />} />
            <Route path="/account/:id" element={<AccountDetailPage />} />
          </Routes>
          </div>
        </div>
      </div>
  );
}
