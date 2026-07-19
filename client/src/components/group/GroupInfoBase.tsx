import { useMemo, useState, type ReactNode } from "react";
import { cn } from "../../cn";
import { FlowsPanel } from "../account/FlowsPanel";
import {
  MONTHLY_PERF_DETAIL_PAGE_SIZE,
  MonthlyPerfDetailTable,
} from "../account/MonthlyPerfDetailTable";
import { PageTitleRow } from "../layout/PageTitleRow";
import { PeriodReturnsStrip } from "../perf/PeriodReturnsStrip";
import { PortfolioNavEntityCardsStrip } from "../dashboard/PortfolioNavEntityCardsStrip";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import type { EntityColorTarget } from "../../entityColor";
import { useTranslation } from "../../i18n";
import { useGroupConsolidatedMonthlyPage } from "../../queries/hooks";
import {
  consolidatedRowsForDisplay,
  useGroupInfoConsolidatedTables,
  type GroupInfoTableAccount,
} from "../../useGroupInfoConsolidatedTables";
import { resolveMonthlyDetailRows } from "./monthlyDetailRows";
import type { CardGroupMetricsPeriod } from "../../dashboardCardBreakdown";
import type { InversionesPeriodMetricsDto } from "../../portfolioNavDashboardCards";
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
  > & {
    inversiones_period_metrics?: InversionesPeriodMetricsDto;
  };
  overviewPoints: Record<string, string | number | null>[];
  metricsPeriod: CardGroupMetricsPeriod;
  showUsd: boolean;
  animated?: boolean;
  /** When false, the strip is omitted (e.g. group page before valuation data is ready). Default true. */
  enabled?: boolean;
  /** While bundle loads: static placeholder values, then one spin to final. */
  placeholderPhase?: boolean;
  compactTitleTo?: string;
};

export type GroupInfoBaseProps = {
  mainClassName?: string;
  title: string;
  colorRgb?: string | null;
  colorTarget?: EntityColorTarget;
  /** e.g. Agrupado / Aportes acumulados toggles (group pages). */
  toolbar?: ReactNode;
  /** Nav node + dashboard bundle for the two-row portfolio card strip. */
  portfolio?: GroupInfoPortfolioStrip | null;
  /** Optional muted notice under cards (e.g. real estate import hint). */
  notice?: ReactNode;
  /** Page-specific charts (valuation, P/L, allocation, …). */
  charts: ReactNode;
  /** Accounts included in monthly detail + flows tables. */
  tableAccounts: readonly GroupInfoTableAccount[];
  /** Accounts tree at the bottom. */
  accountsTree: ReactNode;
  /** Export button row rendered beside the accounts-in-view tree at the bottom. */
  exportSlot?: ReactNode;
  monthlyDetailHint?: string;
  flowsHint?: string;
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
  colorRgb,
  colorTarget,
  toolbar,
  portfolio,
  notice,
  charts,
  tableAccounts,
  accountsTree,
  exportSlot,
  monthlyDetailHint,
  flowsHint,
  loading = false,
  hideConsolidatedTables = false,
  serverPaginatedMonthlyDetail = false,
}: GroupInfoBaseProps) {
  const { t } = useTranslation();
  const { displayUnit, metricsPeriod } = useDisplayPreferences();
  const tablesEnabled =
    !hideConsolidatedTables &&
    (tableAccounts.length > 0 || (loading && Boolean(portfolio?.groupSlug)));
  // Table queries start in parallel with the page bundle (not gated on `loading`);
  // placeholder rows hold the layout until the first page of data resolves.
  const tablesFetchEnabled = tablesEnabled && Boolean(portfolio?.groupSlug);
  const { consolidatedMonthlyPerf, periodReturns, tableFlags, tablesLoading, tablesError } =
    useGroupInfoConsolidatedTables(
      portfolio?.groupSlug ?? "",
      tableAccounts,
      displayUnit,
      tablesFetchEnabled && !serverPaginatedMonthlyDetail
    );

  // Page state is tied to the period it was set under: a month↔year toggle changes the
  // row count, so the derived page snaps back to 1 without an effect (no stale-page fetch).
  const [monthlyPageState, setMonthlyPageState] = useState({ period: metricsPeriod, page: 1 });
  const monthlyPage = monthlyPageState.period === metricsPeriod ? monthlyPageState.page : 1;
  const setMonthlyPage = (page: number) => setMonthlyPageState({ period: metricsPeriod, page });
  const serverMonthly = useGroupConsolidatedMonthlyPage(
    portfolio?.groupSlug ?? "",
    displayUnit,
    metricsPeriod,
    monthlyPage,
    MONTHLY_PERF_DETAIL_PAGE_SIZE,
    tablesFetchEnabled && serverPaginatedMonthlyDetail
  );

  const showPortfolioStrip = portfolio != null && portfolio.enabled !== false;
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
      <div
        className={cn(pageShellStyles.contentShell, loading && pageShellStyles.contentShellLoading)}
      >
        <PageTitleRow title={title} colorRgb={colorRgb} colorTarget={colorTarget} />
        {toolbar}
        {showPortfolioStrip ? (
          <PortfolioNavEntityCardsStrip
            dash={portfolio.dash}
            parentNavNode={portfolio.navNode}
            compactTitle={title}
            compactTitleTo={portfolio.compactTitleTo}
            showUsd={portfolio.showUsd}
            metricsPeriod={portfolio.metricsPeriod}
            animated={portfolio.animated}
            placeholderPhase={portfolio.placeholderPhase ?? loading}
          />
        ) : null}
        {notice}
        {charts}
        {tablesEnabled ? (
          <>
            {!serverPaginatedMonthlyDetail && periodReturns != null ? (
              <>
                <h2 style={{ marginTop: "2rem", fontSize: "1.15rem" }}>{t("periodReturns.title")}</h2>
                <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.5rem", maxWidth: "58rem" }}>
                  {t("periodReturns.hint")}
                </p>
                <PeriodReturnsStrip data={periodReturns} displayUnit={displayUnit} />
              </>
            ) : null}
            <h2 style={{ marginTop: "2rem", fontSize: "1.15rem" }}>
              {t(
                metricsPeriod === "year"
                  ? "groupPage.yearlyDetailTitle"
                  : "groupPage.monthlyDetailTitle"
              )}
            </h2>
            <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.5rem", maxWidth: "58rem" }}>
              {monthlyDetailHint ?? t("groupPage.monthlyDetailHint")}
            </p>
            {monthlyError ? (
              <p className="error">{monthlyError}</p>
            ) : monthlyRows.length > 0 ? (
              <MonthlyPerfDetailTable
                rows={monthlyRows}
                displayUnit={displayUnit}
                isMortgageAccount={tableFlags.isMortgageAccount}
                showStockInflowsColumn={false}
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
            <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.5rem", maxWidth: "58rem" }}>
              {flowsHint ?? t("groupPage.flowsHint")}
            </p>
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
      </div>
    </main>
  );
}
