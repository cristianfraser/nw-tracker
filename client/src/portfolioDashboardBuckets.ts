import { accountCountsTowardGroupTotals, isChartActiveAccount } from "./accountGroupTotals";
import { dashboardCardMainSortKey, type DashboardGroupSlug } from "./dashboardCardBreakdown";
import type { GroupInfoTableAccount } from "./useGroupInfoConsolidatedTables";
import type { DashboardAccountRow, DashboardResponse } from "./types";

export const DASHBOARD_NET_WORTH_BUCKET_SLUGS: readonly DashboardGroupSlug[] = [
  "real_estate",
  "retirement",
  "brokerage",
  "cash_eqs",
];

export function isDashboardNwBucketSlug(slug: string): slug is DashboardGroupSlug {
  return (DASHBOARD_NET_WORTH_BUCKET_SLUGS as readonly string[]).includes(slug);
}

/** Accounts under net-worth buckets for consolidated monthly detail + flows on the home page. */
export function netWorthTableAccountsFromDash(accounts: readonly DashboardAccountRow[]): GroupInfoTableAccount[] {
  return accounts
    .filter(
      (a) =>
        isDashboardNwBucketSlug(a.group_slug) &&
        accountCountsTowardGroupTotals(a) &&
        isChartActiveAccount(a)
    )
    .map((a) => ({
      id: a.account_id,
      name: a.name,
      category_slug: a.category_slug,
    }));
}

/** Primary balance for a dashboard bucket card (for ordering the detail row). */
/** Group page route for a dashboard bucket card title link (fallback when API omits `route_path`). */
export function dashboardBucketRoutePath(bucketSlug: string): string | undefined {
  switch (bucketSlug) {
    case "real_estate":
      return "/real_estate";
    case "retirement":
      return "/inversiones/retiro";
    case "brokerage":
      return "/inversiones/brokerage";
    case "cash_eqs":
      return "/cash_eqs/savings";
    case "liabilities":
      return "/liabilities";
    default:
      return undefined;
  }
}

export function bucketMainSortKeyFromTotals(
  bucket: string,
  totals: DashboardResponse["totals"],
  showUsd: boolean
): number {
  switch (bucket) {
    case "real_estate":
      return dashboardCardMainSortKey(totals.real_estate_clp, totals.real_estate_usd, showUsd);
    case "retirement":
      return dashboardCardMainSortKey(totals.retirement_clp, totals.retirement_usd, showUsd);
    case "brokerage":
      return dashboardCardMainSortKey(totals.brokerage_clp, totals.brokerage_usd, showUsd);
    case "cash_eqs":
      return dashboardCardMainSortKey(totals.cash_eqs_clp, totals.cash_eqs_usd, showUsd);
    default:
      return Number.NEGATIVE_INFINITY;
  }
}
