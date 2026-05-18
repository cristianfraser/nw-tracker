import { Navigate, Route, Routes } from "react-router-dom";
import { AppSidebar } from "./components/AppSidebar";
import { LoadingProvider } from "./context/LoadingContext";
import { AccountDetailPage } from "./pages/AccountDetailPage";
import { AssetGroupPage } from "./pages/AssetGroupPage";
import { DashboardPage } from "./pages/DashboardPage";
import { DepositsPage } from "./pages/DepositsPage";
import { ExpensesPage } from "./pages/ExpensesPage";
import { FlowsLayout } from "./pages/FlowsLayout";
import { IncomePage } from "./pages/IncomePage";
import { InversionesPage } from "./pages/InversionesPage";
import { RatesPage } from "./pages/RatesPage";

export default function App() {
  return (
    <LoadingProvider>
      <div className="layout layout--with-sidebar">
        <AppSidebar />
        <div className="layout-main">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/inversiones/*" element={<InversionesPage />} />
            <Route path="/retirement" element={<Navigate to="/inversiones/retiro" replace />} />
            <Route path="/retirement/*" element={<Navigate to="/inversiones/retiro" replace />} />
            <Route path="/brokerage" element={<Navigate to="/inversiones/brokerage" replace />} />
            <Route path="/brokerage/*" element={<Navigate to="/inversiones/brokerage" replace />} />
            <Route
              path="/cash_eqs"
              element={<AssetGroupPage slug="cash_eqs" />}
            />
            <Route path="/crypto" element={<Navigate to="/inversiones/brokerage/crypto" replace />} />
            <Route path="/real_estate" element={<AssetGroupPage slug="real_estate" />} />
            <Route path="/liabilities" element={<AssetGroupPage slug="liabilities" />} />
            <Route path="/flows" element={<FlowsLayout />}>
              <Route index element={<Navigate to="income" replace />} />
              <Route path="income" element={<IncomePage />} />
              <Route path="expenses" element={<ExpensesPage />} />
              <Route path="deposits" element={<DepositsPage />} />
            </Route>
            <Route path="/rates" element={<RatesPage />} />
            <Route path="/income" element={<Navigate to="/flows/income" replace />} />
            <Route path="/expenses" element={<Navigate to="/flows/expenses" replace />} />
            <Route path="/account/:id" element={<AccountDetailPage />} />
          </Routes>
        </div>
      </div>
    </LoadingProvider>
  );
}
