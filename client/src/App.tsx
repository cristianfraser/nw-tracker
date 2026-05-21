import { Navigate, Route, Routes } from "react-router-dom";
import { AppSidebar } from "./components/AppSidebar";
import { MobileNavDrawer } from "./components/MobileNavDrawer";
import { AppDisplayPreferencesBar } from "./components/AppDisplayPreferencesBar";
import { MarketTickerPanel } from "./components/MarketTickerPanel";
import { DisplayPreferencesProvider } from "./context/DisplayPreferencesContext";
import { LoadingProvider } from "./context/LoadingContext";
import { AccountDetailPage } from "./pages/AccountDetailPage";
import { GroupInfoPage } from "./pages/GroupInfoPage";
import { DashboardPage } from "./pages/DashboardPage";
import { DepositsPage } from "./pages/DepositsPage";
import { ExpensesPage } from "./pages/ExpensesPage";
import { FlowsLayout } from "./pages/FlowsLayout";
import { IncomePage } from "./pages/IncomePage";
import { MessagesPage } from "./pages/MessagesPage";
import { RatesPage } from "./pages/RatesPage";

export default function App() {
  return (
    <LoadingProvider>
      <DisplayPreferencesProvider>
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
            <Route path="/cash_eqs" element={<GroupInfoPage />} />
            <Route path="/crypto" element={<Navigate to="/inversiones/brokerage/crypto" replace />} />
            <Route path="/real_estate" element={<GroupInfoPage />} />
            <Route path="/liabilities" element={<GroupInfoPage />} />
            <Route path="/liabilities/:subgroup" element={<GroupInfoPage />} />
            <Route path="/flows" element={<FlowsLayout />}>
              <Route index element={<Navigate to="income" replace />} />
              <Route path="income" element={<IncomePage />} />
              <Route path="expenses" element={<ExpensesPage />} />
              <Route path="expenses/:groupSlug" element={<ExpensesPage />} />
              <Route path="expenses/:groupSlug/:accountSlug" element={<ExpensesPage />} />
              <Route path="deposits" element={<DepositsPage />} />
            </Route>
            <Route path="/rates" element={<RatesPage />} />
            <Route path="/messages" element={<MessagesPage />} />
            <Route path="/income" element={<Navigate to="/flows/income" replace />} />
            <Route path="/expenses" element={<Navigate to="/flows/expenses" replace />} />
            <Route path="/account/:id" element={<AccountDetailPage />} />
          </Routes>
          </div>
        </div>
      </div>
      </DisplayPreferencesProvider>
    </LoadingProvider>
  );
}
