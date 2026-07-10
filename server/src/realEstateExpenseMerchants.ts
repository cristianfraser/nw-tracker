import { normalizeCcExpenseMerchantKey } from "./ccExpenseCategories.js";

export type RealEstateApartmentSlug = "el_vergel" | "lastarria" | "suecia";

export type RealEstateBillKind =
  | "gas"
  | "electricidad"
  | "internet"
  | "gastos_comunes"
  | "contribuciones"
  | "kwh"
  | "water"
  | "rent";

/**
 * Kinds a purchase can be assigned/linked to. Excludes `kwh` (meter readings, no bill
 * amount) and the read-only `mortgage` slots the payload derives from the depto ledger.
 */
export const REAL_ESTATE_LINKABLE_KINDS: readonly RealEstateBillKind[] = [
  "gas",
  "electricidad",
  "internet",
  "gastos_comunes",
  "contribuciones",
  "water",
  "rent",
];

const GLOBAL_KIND_PATTERNS: Partial<Record<RealEstateBillKind, readonly string[]>> = {
  electricidad: ["ENEL"],
  internet: ["VTR", "ENTEL"],
  gas: ["METROGAS"],
  water: ["AGUAS ANDINAS"],
  gastos_comunes: ["GASTOS COMUNES"],
};

const APARTMENT_COMUNIDAD_PATTERNS: Record<RealEstateApartmentSlug, readonly string[]> = {
  el_vergel: ["COMUNIDAD EL VERGEL"],
  lastarria: ["COMUNIDAD VICTORIA SUBERCASEAUX"],
  suecia: ["COMUNIDAD SUECIA"],
};

function merchantKeyContainsPattern(merchantKey: string, pattern: string): boolean {
  const p = normalizeCcExpenseMerchantKey(pattern);
  if (!p || !merchantKey) return false;
  return merchantKey === p || merchantKey.includes(p) || p.includes(merchantKey);
}

export function merchantPatternsForExpectation(
  accountSlug: RealEstateApartmentSlug,
  kind: string
): string[] {
  const billKind = kind as RealEstateBillKind;
  const patterns: string[] = [];
  const global = GLOBAL_KIND_PATTERNS[billKind];
  if (global) patterns.push(...global);
  if (billKind === "gastos_comunes") {
    patterns.push(...APARTMENT_COMUNIDAD_PATTERNS[accountSlug]);
  }
  return patterns;
}

export function merchantMatchesExpectation(
  accountSlug: RealEstateApartmentSlug,
  kind: string,
  merchantKey: string
): boolean {
  const normalized = normalizeCcExpenseMerchantKey(merchantKey);
  if (!normalized) return false;
  const patterns = merchantPatternsForExpectation(accountSlug, kind);
  return patterns.some((p) => merchantKeyContainsPattern(normalized, p));
}
