/**
 * The F22's arithmetic from income codes to 304 (the IGC) or 34 (the Impuesto Adicional), the
 * code-169 pool, and the check that a filed form reproduces under it — `draft.ts`' header states the
 * chain and the readings behind it.
 */
import { f22Code158, f22Code170, f22Code304, f22Code32, f22Code34, f22ForeignSalaryCreditCap, f22PropertyTaxCreditCap } from "./identities.js";
import { igcTax } from "../legalParameters.js";
import type { F22Codes, F22Regime, F22TaxOptions } from "./types.js";

/**
 * The chain above, from income codes to 304; everything rounded to whole pesos as the form does.
 * For a non-resident (`regime: "nonresident"`) the chain is línea 72's instead: 158 → 32 → 34 at
 * 35 % less code 76; no 170 / 157 / 136 / 304 (there is no IGC).
 */
export function computeF22Tax(
  codes: F22Codes,
  utaClp: number,
  taxYear: number,
  options: F22TaxOptions = {},
  regime: Exclude<F22Regime, "split"> = "resident"
): F22Codes {
  const v = (c: number) => codes[c] ?? 0;
  const out: F22Codes = { ...codes };
  out[158] = Math.round(f22Code158(out));
  if (regime === "nonresident") {
    out[32] = f22Code32(out);
    out[34] = f22Code34(out);
    return out;
  }
  out[170] = Math.max(0, f22Code170(out));
  out[157] = Math.round(igcTax(out[170], utaClp, taxYear));
  out[136] = out[158] > 0 ? Math.round((out[157] * v(152)) / out[158]) : 0;
  if (options.propertyTaxPaidClp != null) {
    const credit = Math.min(Math.round(options.propertyTaxPaidClp), f22PropertyTaxCreditCap(out));
    if (credit > 0) out[1637] = credit;
    else delete out[1637];
  }
  if (options.foreignSalaryCredit != null) {
    const applied = Math.min(options.foreignSalaryCredit.creditClp, f22ForeignSalaryCreditCap(out, options.foreignSalaryCredit.incomeClp));
    if (applied > 0) out[1018] = v(1018) + applied;
  }
  out[304] = f22Code304(out);
  return out;
}

/**
 * The income a code-169 loss may be deducted from: F22 line 17, «Pérdida en operaciones de
 * capitales mobiliarios y ganancias de capital según códigos 105, 155, 152, 1032, 1891, 1104, 1058
 * y 1987 (arts. 54 N° 1 y 62 LIR)», limited to the codes the chain above sums — the others never
 * appear on this taxpayer's returns. 1104 is in it: a fund or crypto loss is deducted from foreign
 * dividends and foreign share gains too (the reverse does not hold, see the header); so is 105, an
 * art. 107 fund's distributions. Art. 107 sale results are not: they net only among themselves,
 * and neither is 1901 (art. 20 N°5 income taxed in first category, line 58 d): a loss on the
 * dollars' exchange result under that route is lost, never a 169 candidate.
 */
export const CAPITAL_LOSS_POOL_CODES: readonly number[] = [105, 155, 152, 1032, 1104];

export function capitalLossPoolClp(codes: F22Codes): number {
  return CAPITAL_LOSS_POOL_CODES.reduce((s, c) => s + Math.max(0, codes[c] ?? 0), 0);
}

/** 169 capped at the pool (observation G60: a larger deduction is excessive). */
export function capCapitalLosses(codes: F22Codes): F22Codes {
  const out: F22Codes = { ...codes };
  const pool = capitalLossPoolClp(codes);
  if ((out[169] ?? 0) > pool) out[169] = pool;
  return out;
}

/** A resident year's filed form must reproduce under the IGC chain; a non-resident's under línea 72's; a departure year's under both. */
export function assertFiledReproduces(taxYear: number, filed: F22Codes, utaClp: number, regime: F22Regime): void {
  const mismatch = (c: number, recomputed: number) => {
    // A code the form does not print is zero.
    if (recomputed !== (filed[c] ?? 0)) {
      throw new Error(`F22 AT${taxYear}: the chain gives ${c} = ${recomputed} but the filed form says ${filed[c]}`);
    }
  };
  if (regime !== "nonresident") {
    const recomputed = computeF22Tax(filed, utaClp, taxYear);
    for (const c of [158, 170, 157, 136, 304]) mismatch(c, recomputed[c]!);
  }
  if (regime === "nonresident") {
    const recomputed = computeF22Tax(filed, utaClp, taxYear, {}, "nonresident");
    for (const c of [158, 32, 34]) mismatch(c, recomputed[c]!);
  }
  if (regime === "split") mismatch(34, f22Code34(filed));
}
