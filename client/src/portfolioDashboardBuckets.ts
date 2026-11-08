import { accountCountsTowardGroupTotals, isChartActiveAccount } from "./accountGroupTotals";
import type { GroupInfoTableAccount } from "./groupInfoTableAccount";
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
