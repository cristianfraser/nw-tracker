import { normalizeCcExpenseMerchantKey } from "./ccExpenseCategories.js";

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

/**
 * Generic Chilean utility merchants per kind. Place-specific patterns (the comunidad /
 * edificio names) live on `expense_accounts.comunidad_merchant_patterns` — data, not code.
 */
const GLOBAL_KIND_PATTERNS: Partial<Record<RealEstateBillKind, readonly string[]>> = {
  electricidad: ["ENEL"],
  internet: ["VTR", "ENTEL", "GTD"],
  gas: ["METROGAS"],
  water: ["AGUAS ANDINAS"],
  gastos_comunes: ["GASTOS COMUNES"],
  contribuciones: ["TGR", "T.G.R."],
};

function merchantKeyContainsPattern(merchantKey: string, pattern: string): boolean {
  const p = normalizeCcExpenseMerchantKey(pattern);
  if (!p || !merchantKey) return false;
  return merchantKey === p || merchantKey.includes(p) || p.includes(merchantKey);
}

/** Comma-separated patterns from `expense_accounts.comunidad_merchant_patterns`. */
export function parseComunidadPatterns(raw: string | null | undefined): string[] {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function merchantPatternsForExpectation(
  comunidadPatterns: string | null | undefined,
  kind: string
): string[] {
  const billKind = kind as RealEstateBillKind;
  const patterns: string[] = [];
  const global = GLOBAL_KIND_PATTERNS[billKind];
  if (global) patterns.push(...global);
  if (billKind === "gastos_comunes") {
    patterns.push(...parseComunidadPatterns(comunidadPatterns));
  }
  return patterns;
}

export function merchantMatchesExpectation(
  comunidadPatterns: string | null | undefined,
  kind: string,
  merchantKey: string
): boolean {
  const normalized = normalizeCcExpenseMerchantKey(merchantKey);
  if (!normalized) return false;
  const patterns = merchantPatternsForExpectation(comunidadPatterns, kind);
  return patterns.some((p) => merchantKeyContainsPattern(normalized, p));
}
