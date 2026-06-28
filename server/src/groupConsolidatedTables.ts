import type { AccountMonthlyPerformanceRow } from "./accountPerformance.js";
import {
  consolidateGroupMonthlyPerf,
  getGroupConsolidationAccountMonthly,
  type ConsolidatedMonthlyPerfRow,
} from "./groupMonthlyPerfConsolidation.js";
import { buildInversionesConsolidatedMonthly, buildNetWorthConsolidatedMonthly } from "./netWorthConsolidation.js";
import { listAccountsForGroupTab } from "./valuationTimeseries.js";
import type { TsUnit } from "./valuationTimeseries.js";

export type { ConsolidatedMonthlyPerfRow } from "./groupMonthlyPerfConsolidation.js";

export type GroupConsolidatedTablesResponse = {
  unit: TsUnit;
  group_slug: string;
  account_monthly: {
    account_id: number;
    name: string;
    category_slug: string;
    monthly: AccountMonthlyPerformanceRow[];
  }[];
  consolidated_monthly: ConsolidatedMonthlyPerfRow[];
};

export function getGroupConsolidatedTables(
  groupSlug: string,
  unit: TsUnit = "clp",
  tabSubgroup?: string
): GroupConsolidatedTablesResponse {
  const rows = listAccountsForGroupTab(groupSlug, tabSubgroup);
  const account_monthly = getGroupConsolidationAccountMonthly(rows, groupSlug, unit);
  const consolidated_monthly =
    groupSlug === "net_worth"
      ? buildNetWorthConsolidatedMonthly(unit)
      : groupSlug === "inversiones" && tabSubgroup == null
        ? buildInversionesConsolidatedMonthly(unit)
        : consolidateGroupMonthlyPerf(
          account_monthly.map((p) => ({
            account_id: p.account_id,
            bucket_slug: p.bucket_slug,
            monthly: p.monthly,
            notes: p.notes,
            name: p.name,
          })),
          unit
        );

  return { unit, group_slug: groupSlug, account_monthly, consolidated_monthly };
}
