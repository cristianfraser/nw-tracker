import { useMemo, useState, type ReactNode } from "react";
import { FlowsPanel } from "../account/FlowsPanel";
import {
  MONTHLY_PERF_DETAIL_PAGE_SIZE,
  MonthlyPerfDetailTable,
} from "../account/MonthlyPerfDetailTable";
import { DailyPerfDetailTable } from "../account/DailyPerfDetailTable";
import { useDailySeries } from "../../queries/hooks";
import { useSurfacePrefs } from "../../surfaceDisplayPrefs";
import { SurfaceControls } from "../ui/SurfaceControls";
import { Loadable } from "../ui/Loadable";
import { PageGridTile } from "../layout/PageGridTile";
import { PageTitleRow } from "../layout/PageTitleRow";
import { cn } from "../../cn";
import { PeriodReturnsWithBenchmark } from "../perf/PeriodReturnsTable";
import { PlaceholderCardsStrip } from "../dashboard/PlaceholderCardsStrip";
import { PortfolioNavEntityCardsStrip } from "../dashboard/PortfolioNavEntityCardsStrip";
import type { ColdStripShape } from "../../coldPageShape";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { useCcInstallmentGastosMode } from "../../useCcInstallmentGastosMode";
import { useTranslation } from "../../i18n";
import { useGroupConsolidatedMonthlyPage, useGroupPeriodReturns } from "../../queries/hooks";
import { queryShowsLoading } from "../../queries/pageShapeReady";
import {
  consolidatedRowsForDisplay,
  periodReturnsForDisplay,
  useGroupInfoConsolidatedTables,
  type GroupInfoTableAccount,
} from "../../useGroupInfoConsolidatedTables";
import { resolveMonthlyDetailRows } from "./monthlyDetailRows";
import { monthYearMetricsPeriod } from "../../dashboardCardBreakdown";
import { buildPlaceholderConsolidatedMonthlyRows } from "../../placeholders/groupPageTablePlaceholders";
import type { DashboardResponse, NavTreeNodeDto, PeriodReturnsPayload } from "../../types";
import pageShellStyles from "../../pages/AccountDetailPage.module.css";
import { queryLoadError } from "../../queries/pageShapeReady";

export type GroupInfoPortfolioStrip = {
  navNode: NavTreeNodeDto;
  groupSlug?: string;
  subgroup?: string;
  dash: Pick<
    DashboardResponse,
    "accounts" | "liabilities_breakdown" | "dashboard_layout" | "card_metrics_by_slug"
  >;
  showUsd: boolean;
  /**
   * Dims the strip while `dash` is a placeholder of its own (a zero strip from the nav tree).
   * Defaults to the page's `loading`. The numbers themselves are shown as given — a cached
   * strip spins to the real one when the bundle lands.
   */
  placeholderPhase?: boolean;
  /** Nodes for `navNode.linked_card_slugs`, resolved against the sidebar nav by the page. */
  linkedCardNavChildren?: NavTreeNodeDto[];
};

type GroupInfoTileId = "returns" | "detail" | "wealth-flows" | "export" | "accounts";

/** What only the home dashboard sets on the shared page body. */
export type GroupInfoDashboardOptions = {
  mainClassName?: string;
  /**
   * Fetch the detalle-por-mes table page by page from the server instead of loading the
   * whole consolidated-tables payload (dashboard net_worth; group pages stay client-paginated).
   */
  serverPaginatedMonthlyDetail: boolean;
  /** i18n key of the flows table heading. */
  flowsTitleKey: string;
  /** The flows table leaves out the checking movements the Expenses page counts as spending. */
  flowsExcludeSpending: boolean;
  /**
   * The rail: tiles that sit beside the strip and the main charts on the big-desktop tier
   * (styles/page-grid.css `.page-rail`) and in the one stack below it. The wide tables, then the
   * export row and the accounts tree, stay below both stacks.
   */
  rail: ReactNode;
  /** Tiles after the band of the main column and the rail (the other charts). */
  pairs: ReactNode;
  /** A tile's place in the one-stack reading order (dashboardLayout.ts). */
  tileOrder: (id: GroupInfoTileId) => number;
  /** Big desktop: a tile's order and span below the band (dashboardLayout.ts). */
  tileWide: (id: GroupInfoTileId) => { order: number; span: number } | undefined;
};

export type GroupInfoBaseProps = {
  /** Page heading; omitted on the home dashboard. */
  title?: string;
  /** Nav node + dashboard bundle for the two-row portfolio card strip. */
  portfolio?: GroupInfoPortfolioStrip | null;
  /** First-ever visit (no nav tree yet, `portfolio` null): the blank card skeleton to draw instead. */
  coldStripShape?: ColdStripShape;
  /** Page-specific charts (valuation, P/L, allocation, …). */
  charts: ReactNode;
  /** Accounts included in monthly detail + flows tables. */
  tableAccounts: readonly GroupInfoTableAccount[];
  /** Accounts tree at the bottom. */
  accountsTree: ReactNode;
  /** Export button row rendered beside the accounts-in-view tree at the bottom. */
  exportSlot?: ReactNode;
  /** Dims the whole page body (title, cards, charts, tables) while bundle data is loading. */
  loading?: boolean;
  /** Skip consolidated monthly perf + flows tables (pasivos specialized layouts). */
  hideConsolidatedTables?: boolean;
  /** The home dashboard's own layout and tables. */
  dashboard?: GroupInfoDashboardOptions;
};

export function GroupInfoBase({
  title,
  portfolio,
  coldStripShape,
  charts,
  tableAccounts,
  accountsTree,
  exportSlot,
  loading = false,
  hideConsolidatedTables = false,
  dashboard,
}: GroupInfoBaseProps) {
  const serverPaginatedMonthlyDetail = dashboard?.serverPaginatedMonthlyDetail ?? false;
  const flowsTitleKey = dashboard?.flowsTitleKey ?? "groupPage.flowsTitle";
  const flowsExcludeSpending = dashboard?.flowsExcludeSpending ?? false;
  const rail = dashboard?.rail;
  const pairs = dashboard?.pairs;
  const tileOrder = dashboard?.tileOrder;
  const tileWide = dashboard?.tileWide;
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const { installmentMode } = useCcInstallmentGastosMode();
  // Detalle table período (persisted per page instance); tables always cover full history.
  const detallePrefs = useSurfacePrefs(
    `group.${portfolio?.groupSlug || "page"}.detalle`,
    "month",
    "total"
  );
  const tablePeriod = detallePrefs.period;
  // The tables always mount (each part has its own empty copy); a page with no group slug yet
  // (cold nav) shows their frames until it has one.
  const tablesEnabled = !hideConsolidatedTables;
  // Table queries start in parallel with the page bundle (not gated on `loading`);
  // placeholder rows hold the layout until the first page of data resolves.
  const tablesFetchEnabled = tablesEnabled && Boolean(portfolio?.groupSlug);
  const {
    consolidatedMonthlyPerf,
    consolidatedYearlyPerf,
    periodReturns,
    tableFlags,
    tablesLoading,
    tablesHeld,
    tablesError,
  } = useGroupInfoConsolidatedTables(
    portfolio?.groupSlug ?? "",
    tableAccounts,
    displayUnit,
    tablesFetchEnabled && !serverPaginatedMonthlyDetail
  );

  // A server-paginated page does not load the consolidated-tables payload: its Rentabilidad
  // table comes alone (`/api/groups/:slug/period-returns`).
  const leanPeriodReturnsQuery = useGroupPeriodReturns(
    portfolio?.groupSlug ?? "",
    displayUnit,
    tablesFetchEnabled && serverPaginatedMonthlyDetail
  );
  // undefined = not here yet (or held prior-unit data); null = the server sends none.
  const leanPeriodReturns = useMemo((): PeriodReturnsPayload | null | undefined => {
    const data = leanPeriodReturnsQuery.data;
    if (!data) return leanPeriodReturnsQuery.isError ? null : undefined;
    if (!data.period_returns) return null;
    return periodReturnsForDisplay(data.period_returns, displayUnit) ?? undefined;
  }, [leanPeriodReturnsQuery.data, leanPeriodReturnsQuery.isError, displayUnit]);
  const shownPeriodReturns = serverPaginatedMonthlyDetail ? leanPeriodReturns : periodReturns;
  const periodReturnsHeld = serverPaginatedMonthlyDetail
    ? leanPeriodReturnsQuery.isPlaceholderData
    : tablesHeld;

  // Page state is tied to the period it was set under: a month↔year toggle changes the
  // row count, so the derived page snaps back to 1 without an effect (no stale-page fetch).
  const [monthlyPageState, setMonthlyPageState] = useState({ period: tablePeriod, page: 1 });
  const monthlyPage = monthlyPageState.period === tablePeriod ? monthlyPageState.page : 1;
  const setMonthlyPage = (page: number) => setMonthlyPageState({ period: tablePeriod, page });
  const serverMonthly = useGroupConsolidatedMonthlyPage(
    portfolio?.groupSlug ?? "",
    displayUnit,
    // Detalle tables are month/year surfaces — the day toggle renders the monthly view.
    monthYearMetricsPeriod(tablePeriod),
    monthlyPage,
    MONTHLY_PERF_DETAIL_PAGE_SIZE,
    tablesFetchEnabled && serverPaginatedMonthlyDetail && tablePeriod !== "day",
    installmentMode
  );

  // Day view: per-day rows over FULL history (tables include all; the first build of a
  // full-history daily series is a known one-time server cost, cached after).
  const isDaily = tablePeriod === "day";
  const dailySeries = useDailySeries(
    { portfolioGroup: portfolio?.groupSlug || undefined },
    displayUnit,
    0,
    isDaily && tablesFetchEnabled
  );

  const stripPlaceholderPhase = portfolio?.placeholderPhase ?? loading;
  const placeholderMonthlyRows = useMemo(() => buildPlaceholderConsolidatedMonthlyRows(), []);

  // A held prior-unit page (keep-previous during a CLP↔USD switch) is never converted; undefined
  // falls back to placeholder rows inside resolveMonthlyDetailRows.
  const serverMonthlyRows = useMemo(() => {
    const resp = serverMonthly.data;
    if (!resp) return undefined;
    return consolidatedRowsForDisplay(resp.rows, resp.unit, displayUnit) ?? undefined;
  }, [serverMonthly.data, displayUnit]);

  const monthlyRows = resolveMonthlyDetailRows({
    serverPaginated: serverPaginatedMonthlyDetail,
    serverRows: serverMonthlyRows,
    clientRows: consolidatedMonthlyPerf,
    pageLoading: loading,
    tablesLoading,
    placeholderRows: placeholderMonthlyRows,
  });
  // The client-paginated yearly view shows the server's yearly rows of the same payload (the
  // placeholder rows while it loads).
  const yearlyRows = monthlyRows === placeholderMonthlyRows ? placeholderMonthlyRows : consolidatedYearlyPerf;
  // Placeholder rows (returned by identity) or held prior-unit / prior-page data: the table dims
  // and never reads as empty.
  const monthlyLoading =
    monthlyRows === placeholderMonthlyRows ||
    (serverPaginatedMonthlyDetail ? serverMonthly.isPlaceholderData : tablesHeld);

  const monthlyError = serverPaginatedMonthlyDetail
    ? queryLoadError(serverMonthly)
      ? serverMonthly.error instanceof Error
        ? serverMonthly.error.message
        : t("common.loadFailedTables")
      : null
    : tablesError;

  const flowsEnabled = tablesFetchEnabled;

  // The strip is a grid of its own (the card blocks are subgrids of it), so its Loadable
  // wrapper is the page-grid child and passes the columns through.
  const strip = portfolio ? (
    <Loadable loading={stripPlaceholderPhase} className="page-grid page-tile" data-tile="strip">
      <PortfolioNavEntityCardsStrip
        dash={portfolio.dash}
        parentNavNode={portfolio.navNode}
        showUsd={portfolio.showUsd}
        linkedCardNavChildren={portfolio.linkedCardNavChildren}
      />
    </Loadable>
  ) : coldStripShape ? (
    <Loadable loading className="page-grid page-tile" data-tile="strip">
      <PlaceholderCardsStrip {...coldStripShape} />
    </Loadable>
  ) : null;
  const exportTile = exportSlot ? (
    <PageGridTile id="export" className="page-tile--end" order={tileOrder?.("export")} wide={tileWide?.("export")}>
      {exportSlot}
    </PageGridTile>
  ) : null;
  const accountsTile = accountsTree ? (
    <PageGridTile id="accounts" order={tileOrder?.("accounts")} wide={tileWide?.("accounts")}>
      {accountsTree}
    </PageGridTile>
  ) : null;

  // undefined = still loading (frame, dimmed — also before the nav names the group); null = the
  // server sends none. With a rail (the dashboard) the table sits in the main stack right under
  // the charts, untitled: the net-worth chart above it names what it measures.
  const returnsTile =
    tablesEnabled && shownPeriodReturns !== null ? (
      <PageGridTile id="returns" order={tileOrder?.("returns")} wide={tileWide?.("returns")}>
        {rail ? null : <h2>{t("periodReturns.title")}</h2>}
        <PeriodReturnsWithBenchmark
          data={shownPeriodReturns ?? null}
          displayUnit={displayUnit}
          scope={{ portfolioGroup: portfolio?.groupSlug ?? "" }}
          surfaceId={`group.${portfolio?.groupSlug || "pending"}.returns`}
          loading={shownPeriodReturns === undefined || periodReturnsHeld}
        />
      </PageGridTile>
    ) : null;

  return (
    <main className={dashboard?.mainClassName}>
      <Loadable loading={loading} className={cn(pageShellStyles.contentShell, "page-grid")}>
        {title != null ? <PageTitleRow title={title} /> : null}
        {rail ? (
          <>
            <div className="page-main">
              {strip}
              {charts}
              {returnsTile}
            </div>
            <div className="page-rail">{rail}</div>
            {pairs}
          </>
        ) : (
          <>
            {strip}
            {charts}
            {pairs}
            {returnsTile}
          </>
        )}
        {tablesEnabled ? (
          <>
            <PageGridTile id="detail" order={tileOrder?.("detail")} wide={tileWide?.("detail")}>
            <div className="chart-panel-title-row">
              <h2>
                {t(
                  isDaily
                    ? "groupPage.dailyDetailTitle"
                    : tablePeriod === "year"
                      ? "groupPage.yearlyDetailTitle"
                      : "groupPage.monthlyDetailTitle"
                )}
              </h2>
              <SurfaceControls period={tablePeriod} onPeriodChange={detallePrefs.setPeriod} />
            </div>
            {isDaily ? (
              queryLoadError(dailySeries) ? (
                <p className="error">
                  {dailySeries.error instanceof Error
                    ? dailySeries.error.message
                    : t("common.loadFailedTables")}
                </p>
              ) : (
                <DailyPerfDetailTable
                  series={dailySeries.data}
                  displayUnit={displayUnit}
                  loading={queryShowsLoading(dailySeries)}
                />
              )
            ) : monthlyError ? (
              <p className="error">{monthlyError}</p>
            ) : monthlyRows.length > 0 || monthlyLoading ? (
              <MonthlyPerfDetailTable
                rows={monthlyRows}
                yearlyRows={yearlyRows}
                displayUnit={displayUnit}
                period={monthYearMetricsPeriod(tablePeriod)}
                isMortgageAccount={tableFlags.isMortgageAccount}
                showStockInflowsColumn={false}
                loading={monthlyLoading}
                serverPagination={
                  serverPaginatedMonthlyDetail && !loading && serverMonthly.data != null
                    ? {
                        page: serverMonthly.data?.page ?? monthlyPage,
                        total: serverMonthly.data?.total ?? 0,
                        onPageChange: setMonthlyPage,
                        loading: queryShowsLoading(serverMonthly),
                      }
                    : undefined
                }
              />
            ) : (
              <p className="muted">{t("groupPage.monthlyDetailEmpty")}</p>
            )}
            </PageGridTile>

            <PageGridTile id="wealth-flows" order={tileOrder?.("wealth-flows")} wide={tileWide?.("wealth-flows")}>
              <h2>{t(flowsTitleKey)}</h2>
              {tablesError ? (
                <p className="error">{tablesError}</p>
              ) : (
                <FlowsPanel
                  kind="group"
                  groupSlug={portfolio?.groupSlug ?? ""}
                  showUnitsColumn={false}
                  excludeSpending={flowsExcludeSpending}
                  enabled={flowsEnabled}
                />
              )}
            </PageGridTile>
          </>
        ) : null}
        {/* The export row and the accounts tree close the page on every tier, rail or not. */}
        {exportTile}
        {accountsTile}
      </Loadable>
    </main>
  );
}
