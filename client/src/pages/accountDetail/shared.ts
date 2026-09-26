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
