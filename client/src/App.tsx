import { Suspense, type ComponentType, type ReactElement } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppSidebar } from "./components/layout/AppSidebar";
import { MobileNavDrawer } from "./components/layout/MobileNavDrawer";
import { AppDisplayPreferencesBar } from "./components/layout/AppDisplayPreferencesBar";
import { MarketTickerPanel } from "./components/layout/MarketTickerPanel";
import { MortgageUfReminderToast } from "./components/layout/MortgageUfReminderToast";
import { DisplayPreferencesProvider, useDisplayPreferences } from "./context/DisplayPreferencesContext";
import { RouteErrorBoundary } from "./components/ui/RouteErrorBoundary";
import { useDemoPageviewBeacon } from "./demoAnalytics";
import { useEnsureFxLatestCache } from "./queries/useEnsureFxLatestCache";
import { useChileDayRolloverInvalidation } from "./queries/useChileDayRolloverInvalidation";
import { useDocumentTitleFromH1 } from "./useDocumentTitleFromH1";
import { useFaviconFromRoute } from "./useFaviconFromRoute";
import { PANEL_SUBROUTES, type PanelSubrouteSlug } from "./pages/panel/panelSubroutes";
import { DashboardPage } from "./pages/DashboardPage";
import { GroupInfoPage } from "./pages/GroupInfoPage";
import { LiabilitiesGroupPage } from "./pages/LiabilitiesGroupPage";
import { AccountDetailPage } from "./pages/AccountDetailPage";
import { FlowsLayout } from "./pages/FlowsLayout";
import { ControlPanelLayout } from "./pages/panel/ControlPanelLayout";
import { lazyChunk, lazyComponent, useIdleChunkPrefetch } from "./lazyChunks";

// Code splitting. The pages a session opens first — dashboard, group, liabilities and account
// pages, and the flows and panel layouts — are in the main bundle, so a document load paints
// the page's own layout at once, never a loading text. The chart engine they would drag in
// (recharts) is one lazy chunk their charts load behind a frame (components/charts/lazyCharts.tsx).
// Every other page is its own chunk, and all chunks are prefetched in idle time after the first
// paint (lazyChunks.ts). Pages use named exports, hence the remapping.
const lazyPage = <T extends Record<string, unknown>, K extends keyof T>(
  load: () => Promise<T>,
  name: K
) => lazyComponent(lazyChunk(load), (module) => module[name] as ComponentType);

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
const GroceriesPage = lazyPage(() => import("./pages/GroceriesPage"), "GroceriesPage");
const FlowsOverviewPage = lazyPage(() => import("./pages/FlowsOverviewPage"), "FlowsOverviewPage");
const FlowsPlPage = lazyPage(() => import("./pages/FlowsPlPage"), "FlowsPlPage");
const IncomePage = lazyPage(() => import("./pages/IncomePage"), "IncomePage");
const AccountsPanelPage = lazyPage(() => import("./pages/panel/AccountsPanelPage"), "AccountsPanelPage");
const ImportSyncPage = lazyPage(() => import("./pages/panel/ImportSyncPage"), "ImportSyncPage");
const NotificationsPage = lazyPage(() => import("./pages/panel/NotificationsPage"), "NotificationsPage");
const SettingsPage = lazyPage(() => import("./pages/panel/SettingsPage"), "SettingsPage");
const MirrorPairsPanelPage = lazyPage(
  () => import("./pages/panel/MirrorPairsPanelPage"),
  "MirrorPairsPanelPage"
);
/** One element per master panel subroute — TS errors here when panelSubroutes.ts grows. */
const PANEL_SUBROUTE_ELEMENTS: Record<PanelSubrouteSlug, ReactElement> = {
  notifications: <NotificationsPage />,
  accounts: <AccountsPanelPage />,
  "import-sync": <ImportSyncPage />,
  "mirror-pairs": <MirrorPairsPanelPage />,
  settings: <SettingsPage />,
};

const RatesPage = lazyPage(() => import("./pages/RatesPage"), "RatesPage");
const ProjectionsPage = lazyPage(() => import("./pages/ProjectionsPage"), "ProjectionsPage");
const TaxReturnPage = lazyPage(() => import("./pages/TaxReturnPage"), "TaxReturnPage");
const WealthPercentilePage = lazyPage(
  () => import("./pages/WealthPercentilePage"),
  "WealthPercentilePage"
);
const WatchlistPage = lazyPage(() => import("./pages/WatchlistPage"), "WatchlistPage");
const NotFoundPage = lazyPage(() => import("./pages/NotFoundPage"), "NotFoundPage");

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
  // Tab title follows the page heading.
  useDocumentTitleFromH1();
  // Tab icon follows the route (bucket/account color halves, flows/settings shapes).
  useFaviconFromRoute();
  // Anonymous route reporting; a no-op outside the hosted demo (endpoint exists there only).
  useDemoPageviewBeacon();
  // Seed the FX cache for CLP↔USD keep-previous conversions on deep links that skip the dashboard.
  useEnsureFxLatestCache();
  // Refetch day-baked payloads right after Chile midnight instead of waiting out staleTime.
  useChileDayRolloverInvalidation();
  // Import the lazy chunks (charts first, then the other pages) once the browser is idle.
  useIdleChunkPrefetch();

  return (
    <div className="layout layout--with-sidebar">
        <MobileNavDrawer>
          <AppSidebar />
        </MobileNavDrawer>
        <MarketTickerPanel />
        <MortgageUfReminderToast />
        <div className="layout-main">
          <AppDisplayPreferencesBar />
          <div className="content">
          <RouteErrorBoundary>
          {/* Blank, and reached only by a direct load of a lazy page's URL before its chunk arrives:
              an in-app navigation is a transition (v7_startTransition) that keeps the previous
              page meanwhile, and once the idle prefetch has run nothing suspends at all. */}
          <Suspense fallback={null}>
          <Routes>
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
              <Route path="expenses/groceries" element={<GroceriesPage />} />
              <Route path="deposits" element={<DepositsPage />} />
              <Route path="deposits/reconciliation" element={<DepositsReconciliationPage />} />
              <Route path="pl" element={<FlowsPlPage />} />
            </Route>
            <Route path="/rates" element={<RatesPage />} />
            <Route path="/projections" element={<ProjectionsPage />} />
            <Route path="/wealth-percentile" element={<WealthPercentilePage />} />
            <Route path="/tax-return" element={<TaxReturnPage />} />
            <Route path="/watchlist" element={<WatchlistPage />} />
            <Route path="/panel" element={<ControlPanelLayout />}>
              <Route index element={<Navigate to="notifications" replace />} />
              {PANEL_SUBROUTES.map((route) => (
                <Route
                  key={route.slug}
                  path={route.slug}
                  element={PANEL_SUBROUTE_ELEMENTS[route.slug]}
                />
              ))}
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
