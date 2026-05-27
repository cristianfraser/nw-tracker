import { normalizeCcExpenseMerchantKey } from "./ccExpenseCategories.js";

export type RealEstateApartmentSlug = "arriendo_a" | "arriendo_b" | "depto";

export type RealEstateBillKind =
  | "gas"
  | "electricidad"
  | "internet"
  | "gastos_comunes"
  | "contribuciones"
  | "kwh"
  | "water";

const GLOBAL_KIND_PATTERNS: Partial<Record<RealEstateBillKind, readonly string[]>> = {
  electricidad: ["ENEL"],
  internet: ["VTR", "ENTEL"],
  gas: ["METROGAS"],
  water: ["AGUAS ANDINAS"],
  gastos_comunes: ["GASTOS COMUNES"],
};

const APARTMENT_COMUNIDAD_PATTERNS: Record<RealEstateApartmentSlug, readonly string[]> = {
  arriendo_a: ["COMUNIDAD ARRIENDO A"],
  arriendo_b: ["COMUNIDAD VICTORIA SUBERCASEAUX"],
  depto: ["COMUNIDAD DEPTO"],
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
