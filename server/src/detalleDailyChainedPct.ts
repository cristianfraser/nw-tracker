import type { AccountMonthlyPerformanceRow } from "./accountPerformance.js";
import { accountIsDebt } from "./accountProfile.js";
import { db } from "./db.js";
import { accountDailyPctPoints, groupDailyPctPoints } from "./dailyPctSeries.js";
import { monthlyPerfForAccountId, type ConsolidatedMonthlyPerfRow } from "./groupMonthlyPerfConsolidation.js";
import { rollupMonthlyPerfYearly } from "./monthlyPerfRollup.js";
import { isLiabilityOnlyScope, withDailyChainedMonthPct } from "./periodPctDailyChain.js";
import { listAccountsForGroupTab, type TsUnit } from "./valuationTimeseries.js";

/**
 * The «Detalle por mes / año» % of the pages that show it: each month the scope's daily returns
 * compounded (`periodPctDailyChain.ts`), each year the compound of its months. Pesos are the
 * monthly rows' own. A scope of liabilities only keeps the one-step rule.
 */

/**
 * {@link monthlyPerfForAccountId} with each month's % compounded from the account's own daily
 * series (`account:<id>`, shared with its page's day view and Rentabilidad), the yearly rows
 * rolled up from those months. For the surfaces that show the %: the account page, its
 * performance endpoint, the export's P/L sheet.
 */
export function monthlyPerfForAccountDisplay(
  accountId: number,
  unit: TsUnit = "clp"
): ReturnType<typeof monthlyPerfForAccountId> {
  const perf = monthlyPerfForAccountId(accountId, unit);
  if (perf == null || accountIsDebt(accountId) || perf.monthly.length === 0) return perf;
  const acc = db.prepare(`SELECT name, import_key FROM accounts WHERE id = ?`).get(accountId) as {
    name: string | null;
    import_key: string | null;
  };
  const points = accountDailyPctPoints(
    { account_id: accountId, name: acc.name, bucket_slug: perf.bucket_slug, import_key: acc.import_key },
    unit
  );
  const monthly: AccountMonthlyPerformanceRow[] = withDailyChainedMonthPct(perf.monthly, points);
  return { ...perf, monthly, yearly: rollupMonthlyPerfYearly(monthly) };
}

/**
 * A group's consolidated monthly rows with each month's % compounded from the group's own daily
 * series (`pg:<slug>`, shared with its page). A legacy sub-tab (`tabSubgroup`) has no daily
 * series of its own and keeps the one-step %.
 */
export function withGroupDailyChainedMonthPct(
  groupSlug: string,
  unit: TsUnit,
  rows: readonly ConsolidatedMonthlyPerfRow[],
  tabSubgroup?: string
): ConsolidatedMonthlyPerfRow[] {
  if (tabSubgroup != null) return [...rows];
  const members = listAccountsForGroupTab(groupSlug).filter((r) => r.account_id > 0);
  if (isLiabilityOnlyScope(members.map((r) => r.account_id), accountIsDebt)) return [...rows];
  const points = groupDailyPctPoints(groupSlug, unit);
  if (points == null) return [...rows];
  return withDailyChainedMonthPct(rows, points);
}
