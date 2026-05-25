import type { ReactNode } from "react";
import { AccountFlowsTable } from "../account/AccountFlowsTable";
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
import type { DashboardResponse, NavTreeNodeDto } from "../../types";

const GROUP_MONTHLY_PERF_COLLAPSED = 12;
const GROUP_FLOWS_COLLAPSED = 10;

export type GroupInfoPortfolioStrip = {
  navNode: NavTreeNodeDto;
  dash: Pick<
    DashboardResponse,
    "accounts" | "totals" | "suecia_snapshot" | "liabilities_breakdown" | "cash_credit_card_links"
  >;
  overviewPoints: Record<string, string | number | null>[];
  metricsPeriod: CardGroupMetricsPeriod;
  showUsd: boolean;
  animated?: boolean;
  /** When false, the strip is omitted (e.g. group page before valuation data is ready). Default true. */
  enabled?: boolean;
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
  /** Accounts tree table at the bottom. */
  accountsTree: ReactNode;
  monthlyDetailHint?: string;
  flowsHint?: string;
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
}: GroupInfoBaseProps) {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const tablesEnabled = tableAccounts.length > 0;
  const { consolidatedMonthlyPerf, consolidatedFlows, tableFlags, tablesLoading } =
    useGroupInfoConsolidatedTables(tableAccounts, displayUnit, tablesEnabled);

  const showPortfolioStrip = portfolio != null && portfolio.enabled !== false;

  return (
    <main className={mainClassName}>
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
          {tablesLoading ? (
            <p className="muted">{t("common.loading")}</p>
          ) : consolidatedMonthlyPerf.length > 0 ? (
            <MonthlyPerfDetailTable
              rows={consolidatedMonthlyPerf}
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
          {tablesLoading ? (
            <p className="muted">{t("common.loading")}</p>
          ) : (
            <AccountFlowsTable
              rows={consolidatedFlows}
              collapsedVisibleRows={GROUP_FLOWS_COLLAPSED}
              showAccountColumn
              showUnitsColumn={false}
              emptyMessage={t("accountDetail.flowsEmpty")}
            />
          )}
        </>
      ) : null}
      {accountsTree}
    </main>
  );
}
