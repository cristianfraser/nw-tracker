import { useMemo, type ReactNode } from "react";
import { cn } from "../../cn";
import { FlowsTable } from "../account/FlowsTable";
import { MonthlyPerfDetailTable } from "../account/MonthlyPerfDetailTable";
import { PageTitleRow } from "../layout/PageTitleRow";
import { PortfolioNavEntityCardsStrip } from "../dashboard/PortfolioNavEntityCardsStrip";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import type { EntityColorTarget } from "../../entityColor";
import { useTranslation } from "../../i18n";
import {
  useGroupInfoConsolidatedTables,
  type GroupInfoTableAccount,
} from "../../useGroupInfoConsolidatedTables";
import type { CardGroupMetricsPeriod } from "../../dashboardCardBreakdown";
import type { InversionesPeriodMetricsDto } from "../../portfolioNavDashboardCards";
import {
  buildPlaceholderConsolidatedMonthlyRows,
  buildPlaceholderGroupFlowRows,
} from "../../placeholders/groupPageTablePlaceholders";
import type { DashboardResponse, NavTreeNodeDto } from "../../types";
import pageShellStyles from "../../pages/AccountDetailPage.module.css";

const GROUP_MONTHLY_PERF_COLLAPSED = 12;
const GROUP_FLOWS_COLLAPSED = 10;

export type GroupInfoPortfolioStrip = {
  navNode: NavTreeNodeDto;
  groupSlug?: string;
  subgroup?: string;
  dash: Pick<
    DashboardResponse,
    "accounts" | "totals" | "suecia_snapshot" | "liabilities_breakdown" | "dashboard_layout"
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
  monthlyDetailHint?: string;
  flowsHint?: string;
  /** Dims the whole page body (title, cards, charts, tables) while bundle data is loading. */
  loading?: boolean;
  /** Skip consolidated monthly perf + flows tables (pasivos specialized layouts). */
  hideConsolidatedTables?: boolean;
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
  monthlyDetailHint,
  flowsHint,
  loading = false,
  hideConsolidatedTables = false,
}: GroupInfoBaseProps) {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const tablesEnabled =
    !hideConsolidatedTables &&
    (tableAccounts.length > 0 || (loading && Boolean(portfolio?.groupSlug)));
  const { consolidatedMonthlyPerf, consolidatedFlows, tableFlags, tablesLoading, tablesError } =
    useGroupInfoConsolidatedTables(
      portfolio?.groupSlug ?? "",
      tableAccounts,
      displayUnit,
      tablesEnabled && Boolean(portfolio?.groupSlug) && !loading
    );

  const showPortfolioStrip = portfolio != null && portfolio.enabled !== false;
  const placeholderMonthlyRows = useMemo(() => buildPlaceholderConsolidatedMonthlyRows(), []);
  const placeholderFlowRows = useMemo(
    () => buildPlaceholderGroupFlowRows(tableAccounts),
    [tableAccounts]
  );
  const monthlyRows = loading
    ? placeholderMonthlyRows
    : tablesLoading
      ? []
      : consolidatedMonthlyPerf;

  const flowRows = loading ? placeholderFlowRows : consolidatedFlows;

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
            overviewPoints={portfolio.overviewPoints}
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
            <h2 style={{ marginTop: "2rem", fontSize: "1.15rem" }}>{t("groupPage.monthlyDetailTitle")}</h2>
            <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.5rem", maxWidth: "58rem" }}>
              {monthlyDetailHint ?? t("groupPage.monthlyDetailHint")}
            </p>
            {tablesError ? (
              <p className="error">{tablesError}</p>
            ) : monthlyRows.length > 0 ? (
              <MonthlyPerfDetailTable
                rows={monthlyRows}
                displayUnit={displayUnit}
                collapsedVisibleRows={GROUP_MONTHLY_PERF_COLLAPSED}
                isMortgageAccount={tableFlags.isMortgageAccount}
                showStockInflowsColumn={false}
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
              <FlowsTable
                rows={flowRows}
                collapsedVisibleRows={GROUP_FLOWS_COLLAPSED}
                showAccountColumn
                showUnitsColumn={false}
                emptyMessage={t("accountDetail.flowsEmpty")}
              />
            )}
          </>
        ) : null}
        {accountsTree}
      </div>
    </main>
  );
}
