/**
 * Every item of one window of an income year, read once for both regimes (`resident.ts` codes
 * them, `nonresident.ts` taxes or excludes them): the block modules over the window.
 */
import type { DateWindow } from "../dateWindow.js";
import { art107DistributionsForYear, art107ForTaxYear, type Art107Distribution, type Art107TaxYear } from "./art107.js";
import { cryptoTaxGainsForYear, type CryptoYearTaxResult } from "./crypto.js";
import { loadF22Dividends } from "./dividends.js";
import { loadFeeReceipts, type F22FeeReceipts } from "./fees.js";
import { foreignInterestForYear, foreignSalaryForYear, type F22ForeignInterest, type F22ForeignSalary, type F22UsTaxReader } from "./foreignIncome.js";
import { foreignShareGainsForYear, type ForeignShareYearResult } from "./foreignShares.js";
import { rentalsForYear, type F22Rentals } from "./rentals.js";
import { payrollTaxYear, type PayrollTaxYear } from "./salary.js";
import { loadFiled } from "./sources.js";
import { optionMovementFacts, type OptionMovementFacts } from "../taxFacts/options.js";
import type { F22DividendLine } from "./types.js";
import type { UsdPurchaseCost, UsdFxPosture } from "../usdCashTaxLotEvents.js";
import { usdFxTaxGainsForYear, type UsdFxDisposalLoader, type UsdFxRoute, type UsdFxYearTaxResult } from "./usdFx.js";

/** Every item of one window the two regimes read: the resident chain codes them, the non-resident part excludes or taxes them. */
export type F22WindowBlocks = {
  window: DateWindow;
  salary: PayrollTaxYear;
  feeReceipts: F22FeeReceipts;
  crypto: CryptoYearTaxResult;
  dividends: F22DividendLine[];
  foreignShares: ForeignShareYearResult;
  art107: Art107TaxYear;
  art107Distributions: Art107Distribution[];
  usdFx: UsdFxYearTaxResult;
  rentals: F22Rentals;
  foreignSalary: F22ForeignSalary;
  foreignInterest: F22ForeignInterest;
};

export type F22YearContext = {
  taxYear: number;
  incomeYear: number;
  todayYmd: string;
  provisional: boolean;
  yearEndObservado: number;
  usdFx: { route: UsdFxRoute; posture: UsdFxPosture; purchaseCost: UsdPurchaseCost; load: UsdFxDisposalLoader | undefined };
  /** How a resident window reads the year's US tax (the 1040's line 24); `f22/draft.ts` provides it. A non-resident window reads none. */
  usTax: F22UsTaxReader;
};

export function loadWindowBlocks(ctx: F22YearContext, window: DateWindow, nonresident: boolean): F22WindowBlocks {
  const { incomeYear, taxYear, todayYmd } = ctx;
  assertNoOptionsInResidentWindow(incomeYear, window, nonresident);
  return {
    window,
    salary: payrollTaxYear(incomeYear, window),
    feeReceipts: loadFeeReceipts(incomeYear, window),
    crypto: cryptoTaxGainsForYear(incomeYear, { window }),
    dividends: loadF22Dividends(incomeYear, window),
    foreignShares: foreignShareGainsForYear(incomeYear, "fifo", todayYmd, window),
    // A non-resident prices art. 107 sales at the general-rule cost (N°7); the departure year's
    // second part carries no loss of its own forward (the resident part keeps the one carry).
    art107: art107ForTaxYear(taxYear, "fifo", todayYmd, loadFiled, {
      window,
      ...(nonresident ? { costChoice: "cost_paid" as const } : {}),
      ...(nonresident && window.fromYmd !== `${incomeYear}-01-01` ? { carry: false as const } : {}),
    }),
    art107Distributions: art107DistributionsForYear(incomeYear, window),
    usdFx: usdFxTaxGainsForYear(
      incomeYear,
      { posture: ctx.usdFx.posture, purchaseCost: ctx.usdFx.purchaseCost, route: ctx.usdFx.route, window },
      ctx.usdFx.load
    ),
    rentals: rentalsForYear(incomeYear, window),
    foreignSalary: foreignSalaryForYear(incomeYear, { observado: ctx.yearEndObservado, provisional: ctx.provisional }, window, nonresident ? null : ctx.usTax),
    foreignInterest: foreignInterestForYear(incomeYear, ctx.yearEndObservado, window),
  };
}

/**
 * Options on the F22 (docs/demo-app-features-plan.md §5, O2): a Chilean resident's result on
 * listed derivatives falls under Ley 20.544 (the derivatives' tax regime), which the draft does not
 * model — an option movement inside a resident window throws rather than leaving the result out.
 * Inside a non-resident window the premiums of a US-listed option are foreign-source (art. 3 LIR):
 * an excluded item (`nonresident.ts`), never silently absent.
 */
export function assertNoOptionsInResidentWindow(incomeYear: number, window: DateWindow, nonresident: boolean): void {
  if (nonresident) return;
  const o = optionMovementFacts(window);
  if (o.movements > 0) {
    throw new Error(
      `F22 ${incomeYear}: ${o.movements} option movement(s) inside the resident window ${window.fromYmd}→${window.throughYmd} — derivatives under Ley 20.544 are not modelled`
    );
  }
}

export type { OptionMovementFacts };
