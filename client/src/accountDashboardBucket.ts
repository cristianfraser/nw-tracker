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

