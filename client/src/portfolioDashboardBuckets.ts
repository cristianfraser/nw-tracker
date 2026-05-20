import type { DashboardGroupSlug } from "./dashboardCardBreakdown";

export const DASHBOARD_NET_WORTH_BUCKET_SLUGS: readonly DashboardGroupSlug[] = [
  "real_estate",
  "retirement",
  "brokerage",
  "cash_eqs",
];

export function isDashboardNwBucketSlug(slug: string): slug is DashboardGroupSlug {
  return (DASHBOARD_NET_WORTH_BUCKET_SLUGS as readonly string[]).includes(slug);
}
