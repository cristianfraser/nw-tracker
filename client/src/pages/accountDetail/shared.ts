export const MONTHLY_PERF_COLLAPSED = 12;
export const ACCOUNT_FLOWS_COLLAPSED = 10;
export const CC_EXTRA_OFFSET_LS = "nw-credit-card-extra-offsets";

export function formatYmEs(ym: string): string {
  const [ys, ms] = ym.split("-");
  const m = Number(ms);
  const names = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const label = m >= 1 && m <= 12 ? names[m - 1] : ym;
  return `${label} ${ys}`;
}

/** Inmueble Suecia (`real_estate` nav bucket or legacy `property` kind). */
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

export function persistExtraCcOffsets(accountId: number, next: Record<string, number>) {
  try {
    localStorage.setItem(`${CC_EXTRA_OFFSET_LS}:${accountId}`, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}
