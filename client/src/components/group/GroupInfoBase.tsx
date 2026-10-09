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
import { PageTitleRow } from "../layout/PageTitleRow";
import { PeriodReturnsWithBenchmark } from "../perf/PeriodReturnsTable";
import { PlaceholderCardsStrip } from "../dashboard/PlaceholderCardsStrip";
import { PortfolioNavEntityCardsStrip } from "../dashboard/PortfolioNavEntityCardsStrip";
import type { ColdStripShape } from "../../coldPageShape";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { useTranslation } from "../../i18n";
import { useGroupConsolidatedMonthlyPage } from "../../queries/hooks";
import {
  consolidatedRowsForDisplay,
  useGroupInfoConsolidatedTables,
  type GroupInfoTableAccount,
} from "../../useGroupInfoConsolidatedTables";
import { resolveMonthlyDetailRows } from "./monthlyDetailRows";
import { monthYearMetricsPeriod } from "../../dashboardCardBreakdown";
import { buildPlaceholderConsolidatedMonthlyRows } from "../../placeholders/groupPageTablePlaceholders";
import type { DashboardResponse, NavTreeNodeDto } from "../../types";
import pageShellStyles from "../../pages/AccountDetailPage.module.css";

export type GroupInfoPortfolioStrip = {
  navNode: NavTreeNodeDto;
  groupSlug?: string;
  subgroup?: string;
  dash: Pick<
    DashboardResponse,
    "accounts" | "totals" | "liabilities_breakdown" | "dashboard_layout" | "card_metrics_by_slug"
  >;
  overviewPoints: Record<string, string | number | null>[];
  showUsd: boolean;
  animated?: boolean;
  /**
   * Static placeholder values, then one spin to final; the strip also dims. Defaults to the
   * page's `loading`; a page passes true when `dash` is a placeholder of its own (cold strip).
   */
  placeholderPhase?: boolean;
  /** Nodes for `navNode.linked_card_slugs`, resolved against the sidebar nav by the page. */
  linkedCardNavChildren?: NavTreeNodeDto[];
};

export type GroupInfoBaseProps = {
  mainClassName?: string;
  title: string;
  /** e.g. Agrupado / Aportes acumulados toggles (group pages). */
  toolbar?: ReactNode;
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
  /**
   * Fetch the detalle-por-mes table page by page from the server instead of loading the
   * whole consolidated-tables payload (dashboard net_worth; group pages stay client-paginated).
   */
  serverPaginatedMonthlyDetail?: boolean;
};

export function GroupInfoBase({
  mainClassName,
  title,
  toolbar,
  portfolio,
  coldStripShape,
  charts,
  tableAccounts,
  accountsTree,
  exportSlot,
  loading = false,
  hideConsolidatedTables = false,
  serverPaginatedMonthlyDetail = false,
}: GroupInfoBaseProps) {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
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
    tablesFetchEnabled && serverPaginatedMonthlyDetail && tablePeriod !== "day"
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

  // During a CLP↔USD switch the held prior-unit page converts via FX (keep-previous), so the
  // table shows approximate values instead of blanking; undefined (no data / no rate) falls
  // back to placeholder rows inside resolveMonthlyDetailRows.
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
  // Placeholder rows (returned by identity) or held prior-unit / prior-page data: the table dims
  // and never reads as empty.
  const monthlyLoading =
    monthlyRows === placeholderMonthlyRows ||
    (serverPaginatedMonthlyDetail ? serverMonthly.isPlaceholderData : tablesHeld);

  const monthlyError = serverPaginatedMonthlyDetail
    ? serverMonthly.isError
      ? serverMonthly.error instanceof Error
        ? serverMonthly.error.message
        : t("common.loadFailedTables")
      : null
    : tablesError;

  const flowsEnabled = tablesFetchEnabled;

  return (
    <main className={mainClassName}>
      <Loadable loading={loading} className={pageShellStyles.contentShell}>
        <PageTitleRow title={title} />
        {toolbar}
        {portfolio ? (
          <Loadable loading={stripPlaceholderPhase}>
            <PortfolioNavEntityCardsStrip
              dash={portfolio.dash}
              parentNavNode={portfolio.navNode}
              showUsd={portfolio.showUsd}
              animated={portfolio.animated}
              placeholderPhase={stripPlaceholderPhase}
              linkedCardNavChildren={portfolio.linkedCardNavChildren}
            />
          </Loadable>
        ) : coldStripShape ? (
          <Loadable loading>
            <PlaceholderCardsStrip {...coldStripShape} />
          </Loadable>
        ) : null}
        {charts}
        {tablesEnabled ? (
          <>
            {/* undefined = still loading (frame, dimmed — also before the nav names the group); null = the server sends none. */}
            {!serverPaginatedMonthlyDetail && periodReturns !== null ? (
              <>
                <h2 style={{ marginTop: "2rem", fontSize: "1.15rem" }}>{t("periodReturns.title")}</h2>
                <PeriodReturnsWithBenchmark
                  data={periodReturns ?? null}
                  displayUnit={displayUnit}
                  scope={{ portfolioGroup: portfolio?.groupSlug ?? "" }}
                  surfaceId={`group.${portfolio?.groupSlug || "pending"}.returns`}
                  loading={periodReturns === undefined || tablesHeld}
                />
              </>
            ) : null}
            <div className="chart-panel-title-row" style={{ marginTop: "2rem" }}>
              <h2 style={{ margin: 0, fontSize: "1.15rem" }}>
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
              dailySeries.isError ? (
                <p className="error">
                  {dailySeries.error instanceof Error
                    ? dailySeries.error.message
                    : t("common.loadFailedTables")}
                </p>
              ) : (
                <DailyPerfDetailTable
                  series={dailySeries.data}
                  displayUnit={displayUnit}
                  loading={dailySeries.isPending || dailySeries.isPlaceholderData}
                />
              )
            ) : monthlyError ? (
              <p className="error">{monthlyError}</p>
            ) : monthlyRows.length > 0 || monthlyLoading ? (
              <MonthlyPerfDetailTable
                rows={monthlyRows}
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
                        loading: serverMonthly.isFetching,
                      }
                    : undefined
                }
              />
            ) : (
              <p className="muted">{t("groupPage.monthlyDetailEmpty")}</p>
            )}

            <h2 style={{ marginTop: "2rem", fontSize: "1.15rem" }}>{t("groupPage.flowsTitle")}</h2>
            {tablesError ? (
              <p className="error">{tablesError}</p>
            ) : (
              <FlowsPanel
                kind="group"
                groupSlug={portfolio?.groupSlug ?? ""}
                showUnitsColumn={false}
                enabled={flowsEnabled}
              />
            )}
          </>
        ) : null}
        {exportSlot ? (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1.25rem" }}>
            {exportSlot}
          </div>
        ) : null}
        {accountsTree}
      </Loadable>
    </main>
  );
}
