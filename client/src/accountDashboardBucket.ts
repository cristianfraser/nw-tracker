/** Top-level NW dashboard buckets (matches server `DASHBOARD_NW_BUCKET_SLUGS`). */
export const DASHBOARD_NW_BUCKET_SLUGS = [
  "real_estate",
  "retirement",
  "brokerage",
  "cash_eqs",
] as const;

export type DashboardNwBucketSlug = (typeof DASHBOARD_NW_BUCKET_SLUGS)[number];

export function accountBelongsToDashboardBucket(
  row: {
    bucket_slug?: string | null;
    group_slug: string;
    dashboard_bucket_slug?: string | null;
  },
  dashboardBucket: string
): boolean {
  if (row.dashboard_bucket_slug != null && row.dashboard_bucket_slug !== "") {
    return row.dashboard_bucket_slug === dashboardBucket;
  }
  const placement = row.bucket_slug ?? row.group_slug;
  return placement === dashboardBucket;
}

export function accountDashboardBucketSlug(row: {
  bucket_slug?: string | null;
  group_slug: string;
  dashboard_bucket_slug?: string | null;
}): string {
  return row.dashboard_bucket_slug ?? row.bucket_slug ?? row.group_slug;
}

export function isDashboardNwBucketSlug(slug: string): slug is DashboardNwBucketSlug {
  return (DASHBOARD_NW_BUCKET_SLUGS as readonly string[]).includes(slug);
}
