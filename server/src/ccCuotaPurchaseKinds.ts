/**
 * Cuota purchases as the Santander card feed types them (2026-09-26, migration 186).
 *
 * The unbilled-movements feed lists a purchase made in cuotas at its full principal and types it
 * in `Descripcion`. The type decides when cuota 1 bills — evidence from every Santander plan on
 * the 2026 statements:
 *   - «CUOTA COMERCIO» (merchant-financed): the purchase cycle's statement prints it as cuota 00/N
 *     and cuota 1 bills at the NEXT close (10 of 10).
 *   - «N/CUOTAS PRECIO CONTADO» / «TRES CUOTAS … CONTADO»: cuota 1 bills at the purchase cycle's
 *     own close (9 of 9).
 * BCI Lider bills «cuota comercio» in the purchase cycle (4 of 4) — but it has no feed, so these
 * rules only ever see Santander rows.
 *
 * The feed never carries the cuota count. A «cuota comercio» purchase comes with a same-day
 * stamp-tax row (IMPTO. DECRETO LEY 3475, same merchant): principal × 0,066% per month of term,
 * the term being cuotas + 1 months, capped at 0,8%. That held for every plan in the statement
 * history (27 exact, 5 at the cap); past the cap the count is only «12 or more».
 */

export type CcCuotaPurchaseKind = "cuota_comercio" | "precio_contado";

export type CcFeedCuotaPurchaseType = {
  kind: CcCuotaPurchaseKind;
  /** Printed in the type itself («TRES CUOTAS …»), else null. */
  cuota_count: number | null;
};

/** The feed's `Descripcion` for the stamp-tax row that accompanies a «cuota comercio» purchase. */
export const STAMP_TAX_FEED_TYPE = "IMPTO. DECRETO LEY 3475";

/**
 * Cuota-purchase type of a feed row, or null for anything else. A description that mentions
 * cuotas but matches no known shape throws: its billing timing is unknown, and guessing it would
 * put the purchase in the wrong facturación. (The «CUOT: … OPER: …» billing-reference rows share
 * the «CUOTAS COMERCIO» / «TRES CUOTAS CONTADO» descriptions; callers skip them first.)
 */
export function cuotaPurchaseTypeFromFeedDescription(
  descripcion: string | null | undefined
): CcFeedCuotaPurchaseType | null {
  const d = String(descripcion ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  if (!d || !/CUOTA/.test(d)) return null;
  if (/^CUOTAS? COMERCIO$/.test(d)) return { kind: "cuota_comercio", cuota_count: null };
  if (/^N\/CUOTAS PRECIO CONTADO$/.test(d)) return { kind: "precio_contado", cuota_count: null };
  if (/^TRES CUOTAS (PRECIO )?CONTADO$/.test(d)) return { kind: "precio_contado", cuota_count: 3 };
  throw new Error(
    `Unknown Santander cuota-purchase type «${descripcion}» — map when its first cuota bills ` +
      `(ccCuotaPurchaseKinds.ts) before importing`
  );
}

const STAMP_TAX_MONTHLY_RATE = 0.00066;
/** 0,8% cap, less a hair so a capped tax rounded down to the peso still reads as capped. */
const STAMP_TAX_CAP_RATE = 0.0079;

export type CcStampTaxCuotaCount =
  | { status: "exact"; cuota_count: number }
  | { status: "capped" }
  | { status: "inconsistent"; months: number };

/**
 * Cuota count implied by a «cuota comercio» purchase's stamp tax: term in months = tax ÷
 * (principal × 0,066%), cuotas = term − 1. `capped` at the 0,8% ceiling (12 or more cuotas);
 * `inconsistent` when the term is not within a quarter month of a whole number (a tiny
 * principal whose peso rounding hides the term, or a tax paired with the wrong purchase).
 */
export function cuotaCountFromStampTax(principalClp: number, taxClp: number): CcStampTaxCuotaCount {
  if (!(principalClp > 0) || !(taxClp > 0)) return { status: "inconsistent", months: 0 };
  const rate = taxClp / principalClp;
  if (rate >= STAMP_TAX_CAP_RATE) return { status: "capped" };
  const months = rate / STAMP_TAX_MONTHLY_RATE;
  const whole = Math.round(months);
  if (Math.abs(months - whole) > 0.25 || whole < 2) return { status: "inconsistent", months };
  return { status: "exact", cuota_count: whole - 1 };
}

/** Billing month of cuota 1 for a purchase made in `purchaseCycleMonth` (YYYY-MM). */
export function firstCuotaBillingMonth(
  kind: CcCuotaPurchaseKind,
  purchaseCycleMonth: string
): string {
  if (kind === "precio_contado") return purchaseCycleMonth;
  const [y, m] = purchaseCycleMonth.split("-").map(Number) as [number, number];
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  return `${next.y}-${String(next.m).padStart(2, "0")}`;
}
