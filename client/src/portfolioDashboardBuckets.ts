import { accountCountsTowardGroupTotals, isChartActiveAccount } from "./accountGroupTotals";
import type { GroupInfoTableAccount } from "./useGroupInfoConsolidatedTables";
import type { DashboardAccountRow } from "./types";

export type DashboardNwBucketSlug = "real_estate" | "retirement" | "brokerage" | "cash_eqs";

export const DASHBOARD_NET_WORTH_BUCKET_SLUGS: readonly DashboardNwBucketSlug[] = [
  "real_estate",
  "retirement",
  "brokerage",
  "cash_eqs",
];

export function isDashboardNwBucketSlug(slug: string): slug is DashboardNwBucketSlug {
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

