import type { AccountMonthlyPerformanceRow } from "./accountPerformance.js";
import { accountChartInactive } from "./accountChartInactive.js";
import { listAccountMovementsForApi, type AccountMovementApiRow } from "./accountMovementsApi.js";
import {
  consolidateGroupMonthlyPerf,
  getGroupConsolidationAccountMonthly,
  type ConsolidatedMonthlyPerfRow,
} from "./groupMonthlyPerfConsolidation.js";
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
  account_movements: {
    account_id: number;
    name: string;
    category_slug: string;
    movements: AccountMovementApiRow[];
  }[];
};

export function getGroupConsolidatedTables(
  groupSlug: string,
  unit: TsUnit = "clp",
  tabSubgroup?: string
): GroupConsolidatedTablesResponse {
  let rows = listAccountsForGroupTab(groupSlug, tabSubgroup);
  if (groupSlug === "net_worth") {
    rows = rows.filter((r) => !accountChartInactive(r.account_id));
  }
  const account_monthly = getGroupConsolidationAccountMonthly(rows, groupSlug, unit);
  const consolidated_monthly = consolidateGroupMonthlyPerf(
    account_monthly.map((p) => ({
      account_id: p.account_id,
      bucket_slug: p.bucket_slug,
      monthly: p.monthly,
      notes: p.notes,
      name: p.name,
    })),
    unit
  );

  const account_movements: GroupConsolidatedTablesResponse["account_movements"] = [];
  for (const r of rows) {
    const movements = listAccountMovementsForApi(r.account_id);
    account_movements.push({
      account_id: r.account_id,
      name: r.name,
      category_slug: r.category_slug,
      movements,
    });
  }

  return { unit, group_slug: groupSlug, account_monthly, consolidated_monthly, account_movements };
}
