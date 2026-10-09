export const MONTHLY_PERF_COLLAPSED = 12;

/** Inmueble Depto (`real_estate` nav bucket or legacy `property` kind). */
export function isDeptoPropertyCategory(categorySlug: string | null | undefined): boolean {
  return categorySlug === "property" || categorySlug === "real_estate";
}

export function isDeptoMortgageCategory(categorySlug: string | null | undefined): boolean {
  return categorySlug === "mortgage";
}

export function movementUnitsKind(categorySlug: string | null | undefined): "shares" | "coin" {
  if (categorySlug === "bitcoin" || categorySlug === "eth") return "coin";
  return "shares";
}

export function tickerLabelFromCategory(slug: string | null | undefined): string {
  if (!slug) return "—";
  switch (slug) {
    case "spy":
      return "SPY";
    case "vea":
      return "VEA";
    case "bitcoin":
      return "BTC";
    case "eth":
      return "ETH";
    default:
      return "—";
  }
}

/**
 * Whether the account can have the Rentabilidad table, judged by its card row's NW bucket (the
 * server only computes `period_returns` under brokerage / retirement; liabilities and the other
 * buckets carry none). Used only to decide if the table is framed while the bundle loads; once
 * loaded, the payload's `null` is the authority. An account whose card row is not known yet may
 * have it.
 */
export function mayHavePeriodReturns(
  row: { dashboard_bucket_slug?: string | null } | null | undefined
): boolean {
  if (!row) return true;
  return row.dashboard_bucket_slug === "brokerage" || row.dashboard_bucket_slug === "retirement";
}
