import type { ReactNode } from "react";
import { AccountFlowsTable } from "./AccountFlowsTable";
import { MonthlyPerfDetailTable } from "./MonthlyPerfDetailTable";
import { PageTitleRow } from "./PageTitleRow";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import type { EntityColorTarget } from "../entityColor";
import { useTranslation } from "../i18n";
import {
  useGroupInfoConsolidatedTables,
  type GroupInfoTableAccount,
} from "../useGroupInfoConsolidatedTables";

const GROUP_MONTHLY_PERF_COLLAPSED = 12;
const GROUP_FLOWS_COLLAPSED = 10;

export type GroupInfoBaseProps = {
  mainClassName?: string;
  title: string;
  colorRgb?: string | null;
  colorTarget?: EntityColorTarget;
  /** e.g. Agrupado / Aportes acumulados toggles (group pages). */
  toolbar?: ReactNode;
  /** Portfolio strip or dashboard bucket cards. */
  cards?: ReactNode;
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
  cards,
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

  return (
    <main className={mainClassName}>
      <PageTitleRow title={title} colorRgb={colorRgb} colorTarget={colorTarget} />
      {toolbar}
      {cards}
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
