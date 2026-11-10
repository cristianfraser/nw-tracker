/**
 * The non-resident part of a year (`draft.ts` header, «Residency»): the Impuesto Adicional on the
 * window's Chilean-source items and the list of what it does not declare, with the reason.
 */
import { computeF22Tax } from "./chain.js";
import { dividendsNetAllClp } from "./dividends.js";
import { fundRedemptionGainsForYear, mortgageInterestForYear } from "./estimates.js";
import { f22Code955 } from "./identities.js";
import type { F22WindowBlocks, F22YearContext } from "./blocks.js";
import { optionMovementFacts } from "../taxFacts/options.js";
import type { F22Codes, F22ExcludedItem, F22ExcludedKind, F22ExcludedReason, F22NonresidentPart } from "./types.js";

/**
 * The non-resident part of a year: the Impuesto Adicional on its window's Chilean-source items —
 * the taxable rents (1849 → 955 → 158 → 32 → 34) and the art. 107 sales (línea 66) — and the list
 * of what the window holds that enters no code, each with its reason (see the header). `whole`:
 * the window is the whole year, so the yearly DJ figures belong to this part too.
 */
export function nonresidentPart(
  ctx: F22YearContext,
  blocks: F22WindowBlocks,
  informed: Record<number, number>,
  utaClp: number,
  whole: boolean
): F22NonresidentPart {
  const { incomeYear, taxYear } = ctx;
  const { window } = blocks;
  if (blocks.salary.months > 0) {
    throw new Error(
      `F22 ${incomeYear}: ${blocks.salary.months} Chilean salary payslip(s) inside the non-resident window ${window.fromYmd}→${window.throughYmd} — art. 60 inc. 2 (20 % Impuesto Adicional on remuneraciones) is not modelled`
    );
  }
  if (blocks.feeReceipts.receipts > 0) {
    throw new Error(
      `F22 ${incomeYear}: ${blocks.feeReceipts.receipts} boleta(s) de honorarios issued inside the non-resident window ${window.fromYmd}→${window.throughYmd} — art. 60 inc. 2 is not modelled`
    );
  }
  if (whole && (informed[1098] != null || informed[162] != null)) {
    throw new Error(`F22 ${incomeYear}: a Chilean employer informed a salary (DJ 1887) for a non-resident year — art. 60 inc. 2 is not modelled`);
  }
  const codes: F22Codes = { ...blocks.art107.codes };
  if (blocks.rentals.taxableRentClp > 0) {
    codes[1849] = blocks.rentals.taxableRentClp;
    codes[955] = f22Code955(codes);
  }
  const taxComputed = blocks.rentals.taxableRentClp > 0 || blocks.art107.codes[1816] !== 0;
  const taxed = taxComputed ? computeF22Tax(codes, utaClp, taxYear, {}, "nonresident") : codes;

  const excluded: F22ExcludedItem[] = [];
  const add = (kind: F22ExcludedKind, reason: F22ExcludedReason, clp: number, count: number) => {
    if (clp !== 0 || count > 0) excluded.push({ kind, reason, clp: Math.round(clp), count, window });
  };
  if (blocks.foreignSalary.stubs.length > 0) add("us_salary", "nonresident", blocks.foreignSalary.grossClp, blocks.foreignSalary.stubs.length);
  if (blocks.dividends.length > 0) add("foreign_dividends", "nonresident", dividendsNetAllClp(blocks.dividends, ctx.yearEndObservado), blocks.dividends.length);
  if (blocks.foreignInterest.lines.length > 0) add("foreign_interest", "nonresident", blocks.foreignInterest.clp, blocks.foreignInterest.lines.length);
  if (blocks.foreignShares.disposals.length > 0) {
    add("foreign_shares", "nonresident", blocks.foreignShares.totalClp[blocks.foreignShares.defaultMode], blocks.foreignShares.disposals.length);
  }
  if (blocks.usdFx.disposals.length > 0) add("usd_fx", "nonresident", blocks.usdFx.resultDecemberClp, blocks.usdFx.disposals.length);
  // A US-listed option's premiums are foreign-source for a non-resident (art. 3): shown, not declared.
  const options = optionMovementFacts(window);
  if (options.movements > 0) {
    if (options.currency != null && options.currency !== "usd") throw new Error(`F22 ${incomeYear}: option premiums in ${options.currency}, expected dollars`);
    add("options", "nonresident", options.netPremium * ctx.yearEndObservado, options.movements);
  }
  if (blocks.crypto.sales.length > 0) add("crypto", "treaty_art13_8", blocks.crypto.gainDecemberClp, blocks.crypto.sales.length);
  // A Chilean fund's redemptions: the lender-style DJ 1894 of a whole non-resident year, else the ledger's estimate.
  const funds = fundRedemptionGainsForYear(incomeYear, window);
  if (whole && (informed[155] != null || (informed[169] != null && informed[1890] == null))) {
    add("fund_redemptions", "fund_unico_withheld", (informed[155] ?? 0) - (informed[169] ?? 0), 0);
  } else if (funds.redemptionsClp > 0) {
    add("fund_redemptions", "fund_unico_withheld", funds.gainClp - funds.lossClp, 1);
  }
  const distributionsClp = Math.round(blocks.art107Distributions.reduce((s, x) => s + x.amountClp, 0));
  if (whole && informed[105] != null) add("fund_distributions", "fund_unico_withheld", informed[105], 0);
  else if (blocks.art107Distributions.length > 0) add("fund_distributions", "fund_unico_withheld", distributionsClp, blocks.art107Distributions.length);
  if (whole && informed[152] != null) add("chile_interest", "withheld_at_source", informed[152], 0);
  if (whole && informed[751] != null) add("mortgage_interest", "no_igc", informed[751], 0);
  else {
    const interest = mortgageInterestForYear(incomeYear, undefined, window);
    if (interest > 0) add("mortgage_interest", "no_igc", interest, 1);
  }
  if (whole && informed[765] != null) add("apv", "no_igc", informed[765], 0);
  if (blocks.rentals.propertyTaxPaidClp > 0) add("property_tax_credit", "no_igc", blocks.rentals.propertyTaxPaidClp, 1);
  return { window, rentals: blocks.rentals, art107: blocks.art107, codes: taxed, excluded, taxComputed };
}
