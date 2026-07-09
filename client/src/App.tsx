import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation, useSearchParams } from "react-router-dom";
import { AppSidebar } from "./components/layout/AppSidebar";
import { MobileNavDrawer } from "./components/layout/MobileNavDrawer";
import { AppDisplayPreferencesBar } from "./components/layout/AppDisplayPreferencesBar";
import { MarketTickerPanel } from "./components/layout/MarketTickerPanel";
import { DisplayPreferencesProvider, useDisplayPreferences } from "./context/DisplayPreferencesContext";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { RouteErrorBoundary } from "./components/ui/RouteErrorBoundary";
import { LoginPage, safeNextPath } from "./pages/LoginPage";
import { useTranslation } from "./i18n";

// Route-level code splitting: each page (and its chart/table deps, notably recharts)
// loads on first navigation instead of shipping in one bundle. Pages use named
// exports, hence the `.then` remapping.
const lazyPage = <T extends Record<string, unknown>, K extends keyof T>(
  load: () => Promise<T>,
  name: K
) => lazy(async () => ({ default: (await load())[name] as React.ComponentType }));

const AccountDetailPage = lazyPage(() => import("./pages/AccountDetailPage"), "AccountDetailPage");
const GroupInfoPage = lazyPage(() => import("./pages/GroupInfoPage"), "GroupInfoPage");
const LiabilitiesGroupPage = lazyPage(() => import("./pages/LiabilitiesGroupPage"), "LiabilitiesGroupPage");
const DashboardPage = lazyPage(() => import("./pages/DashboardPage"), "DashboardPage");
const DepositsPage = lazyPage(() => import("./pages/DepositsPage"), "DepositsPage");
const DepositsReconciliationPage = lazyPage(
  () => import("./pages/DepositsReconciliationPage"),
  "DepositsReconciliationPage"
);
const ExpensesPage = lazyPage(() => import("./pages/ExpensesPage"), "ExpensesPage");
const RealEstateExpensesPage = lazyPage(
  () => import("./pages/RealEstateExpensesPage"),
  "RealEstateExpensesPage"
);
const FlowsLayout = lazyPage(() => import("./pages/FlowsLayout"), "FlowsLayout");
const FlowsOverviewPage = lazyPage(() => import("./pages/FlowsOverviewPage"), "FlowsOverviewPage");
const IncomePage = lazyPage(() => import("./pages/IncomePage"), "IncomePage");
const ControlPanelLayout = lazyPage(() => import("./pages/panel/ControlPanelLayout"), "ControlPanelLayout");
const AccountsPanelPage = lazyPage(() => import("./pages/panel/AccountsPanelPage"), "AccountsPanelPage");
const ImportSyncPage = lazyPage(() => import("./pages/panel/ImportSyncPage"), "ImportSyncPage");
const NotificationsPage = lazyPage(() => import("./pages/panel/NotificationsPage"), "NotificationsPage");
const SettingsPage = lazyPage(() => import("./pages/panel/SettingsPage"), "SettingsPage");
const MirrorPairsPanelPage = lazyPage(
  () => import("./pages/panel/MirrorPairsPanelPage"),
  "MirrorPairsPanelPage"
);
const RatesPage = lazyPage(() => import("./pages/RatesPage"), "RatesPage");
const ProjectionsPage = lazyPage(() => import("./pages/ProjectionsPage"), "ProjectionsPage");
const WatchlistPage = lazyPage(() => import("./pages/WatchlistPage"), "WatchlistPage");
const NotFoundPage = lazyPage(() => import("./pages/NotFoundPage"), "NotFoundPage");

export default function App() {
  return (
    <AuthProvider>
      <DisplayPreferencesProvider>
        <AppTree />
      </DisplayPreferencesProvider>
    </AuthProvider>
  );
}

/** Full-viewport centered message (auth check in flight). */
function FullScreenMessage({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--space-2xl)",
      }}
    >
      <p className="muted">{children}</p>
    </div>
  );
}

/** Anonymous + on a gated route → bounce to /login, remembering where we were headed. */
function RedirectToLogin() {
  const loc = useLocation();
  const next = encodeURIComponent(`${loc.pathname}${loc.search}`);
  return <Navigate to={`/login?next=${next}`} replace />;
}

/** Authenticated user landing on /login → forward to the remembered `next` (or home). */
function LoginRedirect() {
  const [searchParams] = useSearchParams();
  return <Navigate to={safeNextPath(searchParams.get("next"))} replace />;
}

/**
 * The whole tree lives inside a context consumer: a display-preference change
 * (e.g. decimal separator) re-renders it top-down, so plain format helpers
 * re-run everywhere without remounting anything (no loading flash, state kept).
 *
 * It also carries the demo auth gate: while the session status is unknown we show a
 * spinner; when auth is required but absent, only the bare `/login` page renders (no app
 * chrome, routes never mount); otherwise the normal app renders.
 */
function AppTree() {
  useDisplayPreferences();
  const { status, authRequired } = useAuth();
  const { t } = useTranslation();

  if (status === "loading") {
    return <FullScreenMessage>{t("common.loading")}</FullScreenMessage>;
  }

  if (authRequired && status === "anonymous") {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<RedirectToLogin />} />
      </Routes>
    );
  }

  return (
    <div className="layout layout--with-sidebar">
        <MobileNavDrawer>
          <AppSidebar />
        </MobileNavDrawer>
        <MarketTickerPanel />
        <div className="layout-main">
          <AppDisplayPreferencesBar />
          <div className="content">
          <RouteErrorBoundary>
          <Suspense fallback={<p className="muted">{t("common.loading")}</p>}>
          <Routes>
            <Route path="/login" element={<LoginRedirect />} />
            <Route path="/" element={<DashboardPage />} />
            <Route path="/inversiones/*" element={<GroupInfoPage />} />
            <Route path="/cash_eqs/*" element={<GroupInfoPage />} />
            <Route path="/real_estate" element={<GroupInfoPage />} />
            <Route path="/liabilities" element={<LiabilitiesGroupPage />} />
            <Route path="/liabilities/:subgroup/:issuer" element={<LiabilitiesGroupPage />} />
            <Route path="/liabilities/:subgroup" element={<LiabilitiesGroupPage />} />
            <Route path="/flows" element={<FlowsLayout />}>
              <Route index element={<FlowsOverviewPage />} />
              <Route path="income" element={<IncomePage />} />
              <Route path="expenses" element={<ExpensesPage />} />
              <Route path="expenses/real_estate" element={<RealEstateExpensesPage />} />
              <Route path="expenses/real_estate/:accountSlug" element={<RealEstateExpensesPage />} />
              <Route path="deposits" element={<DepositsPage />} />
              <Route path="deposits/reconciliation" element={<DepositsReconciliationPage />} />
            </Route>
            <Route path="/rates" element={<RatesPage />} />
            <Route path="/projections" element={<ProjectionsPage />} />
            <Route path="/watchlist" element={<WatchlistPage />} />
            <Route path="/panel" element={<ControlPanelLayout />}>
              <Route index element={<Navigate to="notifications" replace />} />
              <Route path="notifications" element={<NotificationsPage />} />
              <Route path="accounts" element={<AccountsPanelPage />} />
              <Route path="import-sync" element={<ImportSyncPage />} />
              <Route path="mirror-pairs" element={<MirrorPairsPanelPage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
            <Route path="/account/:id" element={<AccountDetailPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
          </Suspense>
          </RouteErrorBoundary>
          </div>
        </div>
      </div>
  );
}
