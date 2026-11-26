import { allocationBucketColor } from "../../chartColors";
import type { FlowsPlBucketSlug } from "../../types";

/**
 * The /flows P/L page's buckets in the server's order (`FLOWS_PL_BUCKETS`), each in its nav
 * bucket's colour: the «P/L by bucket» chart's bars and the period rows.
 */
export const FLOWS_PL_BUCKET_SERIES: readonly { slug: FlowsPlBucketSlug; color: string }[] = [
  { slug: "brokerage", color: allocationBucketColor("brokerage") },
  { slug: "retirement", color: allocationBucketColor("retirement") },
  { slug: "cash", color: allocationBucketColor("cash_eqs") },
  { slug: "real_estate", color: allocationBucketColor("real_estate") },
];

/** The total's line on the chart and its mark on a row's bar. */
export const FLOWS_PL_TOTAL_COLOR = "#e2e8f0";
