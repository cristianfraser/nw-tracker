/**
 * The resident part of a year — the whole year, or the departure year through the declared day
 * (`draft.ts` header): the base (filed form, informed DJs, liquidaciones, fees or nothing), the
 * codes the app states itself on top of it, the estimates of what third parties report later, and
 * the IGC chain, with the year's offsets.
 */
import type { DateWindow } from "../dateWindow.js";
import { FOREIGN_TAX_CREDIT_CAP, IDPC_RATE } from "../legalParameters.js";
import type { InformedDjField } from "../siiInformedDj.js";
import type { F22WindowBlocks } from "./blocks.js";
import { capCapitalLosses, computeF22Tax } from "./chain.js";
import { fundRedemptionGainsForYear, mortgageInterestDeduction, mortgageInterestForYear } from "./estimates.js";
import { feesBox, writeFeesBoxCodes } from "./fees.js";
import { f22Code305, f22Code955, f22ForeignSalaryCreditCap, f22PropertyTaxCreditCap } from "./identities.js";
import { capitalLossOffset, foreignShareOffset } from "./offsets.js";
import { ART107_RATE } from "./art107.js";
import { apvRegimeBDeductionClp, informedWithDetailCodes } from "./sources.js";
import type { F22Codes, F22Draft, F22DraftBase, F22FeesBox, F22NonresidentPart, F22TaxOptions } from "./types.js";

/** Codes of the payment section, which the draft leaves to the SII. */
export const PAYMENT_SECTION_CODES: readonly number[] = [39, 85, 86, 87, 90, 91, 92, 93, 94, 795];

/** What the resident part decides; the rest of {@link F22Draft} is the year's shared detail. */
export type F22ResidentResult = Pick<
  F22Draft,
  | "base"
  | "taxComputed"
  | "fees"
  | "draft"
  | "foreignSharesIdpcClp"
  | "estimatedCodes"
  | "lossOffset"
  | "foreignShareOffset"
  | "usdFxIdpcClp"
  | "propertyTaxCredit"
  | "foreignSalaryCredit"
>;

export type F22ResidentInput = {
  taxYear: number;
  incomeYear: number;
  /** A departure year: this part runs through the declared day and `nonresident` is the rest. */
  split: boolean;
  residentWindow: DateWindow;
  blocks: F22WindowBlocks;
  filed: F22Codes | null;
  dj: Map<number, InformedDjField[]>;
  /** The informed codes; the APV rebate (765) is dropped from it IN PLACE when the filed form declared the APV as an independiente (770). */
  informed: Record<number, number>;
  utaClp: number;
  yearEndObservado: number;
  art107DistributionsClp: number;
  nonresident: F22NonresidentPart | null;
};

export function residentPart(input: F22ResidentInput): F22ResidentResult {
  const { taxYear, incomeYear, split, residentWindow, blocks, filed, dj, informed, utaClp, yearEndObservado, art107DistributionsClp, nonresident } =
    input;
  const { salary, crypto, dividends, foreignShares, art107, usdFx, rentals, foreignSalary, foreignInterest } = blocks;
  // A return that already declared the APV as a worker independiente (code 770, AT2022) must not
  // get it again as an employee's rebate.
  // A year with fee income declares the APV as a worker independiente (code 770, in the fees box,
  // also pesos at the 31-December UF): AT2022 filed 770 = 68.105 — the UF figure typed as pesos,
  // ~2,1 M short. The draft states 770 in pesos and moves the fees' net (110) by the difference.
  const apvIndependiente = filed?.[770] != null ? apvRegimeBDeductionClp(dj, incomeYear) : null;
  if (filed?.[770] != null) delete informed[765];
  const feeReceipts = filed ? null : blocks.feeReceipts;
  const hasFees = feeReceipts != null && feeReceipts.receipts > 0;
  const base: F22DraftBase = filed
    ? "filed"
    : Object.keys(informed).length > 0
      ? "informed"
      : salary.months > 0
        ? "payroll"
        : hasFees
          ? "fees"
          : "none";
  // The lender's DJ 1898 states the interest paid; the deduction (750) is the art. 55 bis share of
  // it, decided below on the gross income like the ledger estimate. In a departure year the DJ's
  // yearly figure covers months a non-resident cannot deduct: the ledger's interest through the
  // declared day stands in (estimated).
  const informedMortgageInterest = split ? null : informed[751] ?? null;

  const foreignResult = Math.round(foreignShares.totalClp[foreignShares.defaultMode]);
  const foreignGain = Math.max(0, foreignResult);
  // The route decides the codes: 1901 (+ IDPC beside) or the crypto's 1032 / 169.
  const usdFx1901 = usdFx.codes[1901] ?? 0;
  const usdFx1032 = usdFx.codes[1032] ?? 0;
  const usdFxLoss = usdFx.codes.loss169 ?? 0;
  const usdFxIdpcClp = usdFx.codes.idpcClp ?? 0;
  const foreignSalaryIncomeClp = foreignSalary.netClp + foreignSalary.creditClp;
  // With taxable rent the app states 1849 / 955 and derives 1637; without, a filed form keeps its own.
  // A foreign salary's credit enters 1018 capped by the chain (no refund).
  const taxOptions: F22TaxOptions = {
    ...(rentals.taxableRentClp > 0 ? { propertyTaxPaidClp: rentals.propertyTaxPaidClp } : {}),
    ...(foreignSalary.creditClp > 0 ? { foreignSalaryCredit: { creditClp: foreignSalary.creditClp, incomeClp: foreignSalaryIncomeClp } } : {}),
  };

  const draftInput: F22Codes =
    base === "filed"
      ? { ...filed!, ...informedWithDetailCodes(informed) }
      : base === "informed"
        ? informedWithDetailCodes(informed)
        : base === "payroll"
          ? { 1098: salary.taxablePayClp, 161: salary.taxablePayClp, 162: salary.withheldTaxClp }
          : {};
  let fees: F22FeesBox | null = null;
  if (hasFees) {
    // An APV régimen B deposit goes in the fees box when no employer reported the year (765 otherwise).
    const apv = draftInput[1098] == null ? apvRegimeBDeductionClp(dj, incomeYear) ?? 0 : 0;
    fees = feesBox(feeReceipts!, utaClp, apv);
    writeFeesBoxCodes(draftInput, fees);
  }
  if (apvIndependiente != null && filed?.[770] != null && filed[110] != null) {
    draftInput[770] = apvIndependiente;
    draftInput[110] = filed[110] - (apvIndependiente - filed[770]);
    for (const c of [467, 618]) if (filed[c] === filed[110]) draftInput[c] = draftInput[110]!;
  }
  // The rebate cannot exceed the salary declared (code 161).
  if (draftInput[765] != null) draftInput[765] = Math.min(draftInput[765]!, draftInput[161] ?? draftInput[1098] ?? 0);
  const cryptoGain = Math.round(crypto.gainDecemberClp);
  const detailed = dividends.filter((d) => d.grossUsd != null && d.withholdingUsd != null);
  const grossClp = detailed.reduce((s, d) => s + d.grossUsd!, 0) * yearEndObservado;
  const taxClp = detailed.reduce((s, d) => s + d.withholdingUsd!, 0) * yearEndObservado;
  const dividendsNetClp = Math.round(grossClp - taxClp);
  const appCodes: F22Codes = {
    1032: Math.max(0, cryptoGain) + usdFx1032,
    1104: dividendsNetClp + foreignGain + foreignInterest.clp,
    // The gross-up: the dividends' foreign tax and the foreign salary's credit (art. 41 A).
    748: Math.round(taxClp) + foreignSalary.creditClp,
    1018: Math.round(Math.min(taxClp, FOREIGN_TAX_CREDIT_CAP * grossClp)),
    1901: usdFx1901,
    ...art107.codes,
  };
  for (const [c, v] of Object.entries(appCodes)) {
    // A year with no base shows only what the app has; zeros would read as a declared zero.
    if (base !== "none" || v !== 0) draftInput[Number(c)] = v;
  }
  if (foreignSalary.grossClp > 0) {
    // Línea 13: 1030 beside 1098, and 161 their total.
    draftInput[1030] = foreignSalary.netClp;
    draftInput[161] = (draftInput[1098] ?? 0) + foreignSalary.netClp;
  }
  if (rentals.taxableRentClp > 0) {
    draftInput[1849] = rentals.taxableRentClp;
    draftInput[955] = f22Code955(draftInput);
  }
  const declaredLossClp = draftInput[169] ?? 0;
  const addLoss = (clp: number) => {
    if (clp > 0) draftInput[169] = (draftInput[169] ?? 0) + clp;
  };
  addLoss(-cryptoGain);
  addLoss(usdFxLoss);

  // Without a filed form or informed DJs, the codes third parties report in March come from the
  // ledger too (f22/estimates): fund redemptions and mortgage interest.
  const estimatedCodes: number[] = [];
  // The dollars' exchange result is the app's own reading of the lots, not yet filed anywhere.
  if (usdFx1901 > 0) estimatedCodes.push(1901);
  if (usdFx1032 > 0) estimatedCodes.push(1032);
  if (usdFxLoss > 0) estimatedCodes.push(169);
  let fundLossClp = 0;
  let mortgageInterest = informedMortgageInterest ?? 0;
  // Over a filed form the lender's figure replaces the filed 751, and 750 is drafted from it; in a
  // departure year the ledger's part-year figure does.
  if ((base === "filed" && informedMortgageInterest != null) || split) {
    delete draftInput[750];
    delete draftInput[751];
  }
  if (base === "payroll" || base === "fees" || base === "none") {
    const funds = fundRedemptionGainsForYear(incomeYear, residentWindow);
    if (funds.gainClp > 0) {
      draftInput[155] = funds.gainClp;
      draftInput[1869] = funds.gainClp;
      estimatedCodes.push(155, 1869);
    }
    if (funds.lossClp > 0) {
      fundLossClp = funds.lossClp;
      addLoss(funds.lossClp);
      estimatedCodes.push(169);
    }
  }
  if (informedMortgageInterest == null && (split || base === "payroll" || base === "fees" || base === "none")) {
    mortgageInterest = mortgageInterestForYear(incomeYear, undefined, residentWindow);
    if (mortgageInterest > 0) estimatedCodes.push(750, 751);
  }
  // An art. 107 fund's distributions are dividends afectos al IGC (línea 2, code 105): the DJ 1922
  // figure (or the filed one) when there is one, else the cash credited as an estimate — the IDPC
  // credit they carry (610) comes only with the DJ / the fund's certificate (see informedDj1922Codes).
  if (draftInput[105] == null && art107DistributionsClp > 0) {
    draftInput[105] = art107DistributionsClp;
    estimatedCodes.push(105);
  }

  // Losses capped at the pool, then the mortgage interest, whose deduction depends on the gross.
  const finish = (codes: F22Codes): F22Codes => {
    const out = capCapitalLosses(codes);
    if (mortgageInterest > 0) {
      out[751] = mortgageInterest;
      out[750] = mortgageInterestDeduction(mortgageInterest, computeF22Tax(out, utaClp, taxYear)[158]!, utaClp);
    }
    return out;
  };
  const tax = (codes: F22Codes) => computeF22Tax(codes, utaClp, taxYear, taxOptions);
  const residentTaxComputed =
    base !== "none" || estimatedCodes.length > 0 || rentals.taxableRentClp > 0 || foreignSalary.grossClp > 0 || foreignInterest.clp > 0;
  const taxComputed = residentTaxComputed || (nonresident?.taxComputed ?? false);
  const draft = residentTaxComputed ? tax(finish(draftInput)) : finish(draftInput);
  if (nonresident) {
    // The departure year's second part: its Impuesto Adicional beside the resident IGC, art. 107 summed with one carry.
    const nr = nonresident.codes;
    if (nr[32] != null) draft[32] = nr[32];
    if (nr[34] != null) draft[34] = nr[34];
    for (const c of [1809, 1813, 1814] as const) draft[c] = (draft[c] ?? 0) + (nr[c] ?? 0);
    draft[1816] = (draft[1814] ?? 0) + (draft[1815] ?? 0);
    draft[1829] = Math.max(0, draft[1816]);
    draft[1830] = Math.round(ART107_RATE * draft[1829]);
  }
  if (taxComputed) {
    draft[305] = f22Code305(draft);
    // Code 31 is the IGC to pay; a return with a refund does not print it.
    if ((draft[304] ?? 0) > 0) draft[31] = draft[304]!;
  }

  const taxOf = (codes: F22Codes) => tax(finish(codes))[304]!;
  const lossOffset = capitalLossOffset({
    draftInput,
    draft,
    taxOf,
    taxed: residentTaxComputed,
    cryptoGain,
    foreignGain,
    dividendsNetClp,
    declaredLossClp,
    fundLossClp,
    usdFx1032,
    usdFxLoss,
  });
  const foreignOffset = foreignShareOffset({ foreignShares, foreignResult, draftInput, draft, taxOf, taxed: residentTaxComputed });
  // The payment section (reajuste art. 72, total to pay, filing-date surcharges) depends on when a
  // rectification is paid; the SII computes it then.
  for (const c of PAYMENT_SECTION_CODES) delete draft[c];

  return {
    base,
    taxComputed,
    fees,
    draft,
    foreignSharesIdpcClp: Math.round(foreignGain * IDPC_RATE),
    estimatedCodes,
    lossOffset,
    foreignShareOffset: foreignOffset,
    usdFxIdpcClp,
    propertyTaxCredit:
      residentTaxComputed && rentals.taxableRentClp > 0
        ? {
            paidClp: rentals.propertyTaxPaidClp,
            capClp: f22PropertyTaxCreditCap(draft),
            creditClp: draft[1637] ?? 0,
          }
        : null,
    foreignSalaryCredit:
      residentTaxComputed && foreignSalary.creditClp > 0
        ? {
            creditClp: foreignSalary.creditClp,
            capClp: f22ForeignSalaryCreditCap(draft, foreignSalaryIncomeClp),
            appliedClp: Math.min(foreignSalary.creditClp, f22ForeignSalaryCreditCap(draft, foreignSalaryIncomeClp)),
          }
        : null,
  };
}
