/**
 * The F22 draft's types (`draft.ts` composes them; every block module returns its own).
 */
import type { DateWindow } from "../dateWindow.js";
import type { YearResidency } from "../taxResidency.js";
import type { UsdFxPosture, UsdPurchaseCost } from "../usdCashTaxLotEvents.js";
import type { Art107Distribution, Art107TaxYear } from "./art107.js";
import type { CryptoYearTaxResult } from "./crypto.js";
import type { F22ForeignInterest, F22ForeignSalary } from "./foreignIncome.js";
import type { ForeignShareYearResult } from "./foreignShares.js";
import type { F22Rentals } from "./rentals.js";
import type { PayrollTaxYear } from "./salary.js";
import type { UsdFxDisposalLoader, UsdFxRoute, UsdFxYearTaxResult } from "./usdFx.js";

export type F22Codes = Record<number, number>;

/** What {@link computeF22Tax} may derive beyond the codes. */
export type F22TaxOptions = {
  /**
   * The contribuciones paid on the rented properties of 1849: the chain then derives 1637 as this
   * amount capped at the IGC on the rent ({@link f22PropertyTaxCreditCap}). Absent, 1637 is read
   * from the codes (a filed form).
   */
  propertyTaxPaidClp?: number;
  /**
   * A foreign salary's credit before its IGC cap and the income it was earned on (1030 + its 748):
   * the chain adds min(credit, {@link f22ForeignSalaryCreditCap}) to the 1018 in the codes (the
   * dividends' credit). Absent, 1018 is read from the codes.
   */
  foreignSalaryCredit?: { creditClp: number; incomeClp: number };
};

/** The regime of an income year under the declared residency (`taxResidency.ts`). */
export type F22Regime = "resident" | "nonresident" | "split";

export type F22LossOffsetSource = "crypto" | "foreign_shares" | "foreign_dividends" | "funds_interest" | "usd_fx";

/** Gains and losses that offset each other within one year, and what is left on either side. */
export type F22OffsetBalance = {
  gainsClp: number;
  lossesClp: number;
  deductedClp: number;
  /** Losses the pool's gains do not absorb; lost when the year ends. */
  unusedLossClp: number;
  /** Gains no loss offsets; taxed. */
  taxedGainClp: number;
  /**
   * The IGC at stake, null without a tax chain: for an unused loss, what a pool gain of that size
   * would cost without it; for a taxed gain, what a loss of that size would save.
   */
  taxEffectClp: number | null;
};

/** The year's code-169 pool, with what each source put in. */
export type F22LossOffset = F22OffsetBalance & {
  parts: { source: F22LossOffsetSource; gainClp: number; lossClp: number }[];
};

export type F22DividendLine = {
  date: string;
  movementId: number;
  /** Null while the broker document with the gross / withholding split has not been imported. */
  grossUsd: number | null;
  withholdingUsd: number | null;
  netUsd: number;
};

/**
 * Where the draft's other codes come from, in this order: the filed form, the informed DJs, the
 * imported liquidaciones (salary codes 1098 / 161 / 162, `payrollTaxYear`), the boletas de
 * honorarios issued (the fees box), or nothing. Fees are added to an informed or payroll base too.
 */
export type F22DraftBase = "filed" | "informed" | "payroll" | "fees" | "none";

/** The fees box drafted from the boletas issued in the income year (null: none issued, or a filed year). */
export type F22FeesBox = {
  receipts: number;
  grossClp: number;
  /** 494: 30 % of the gross, at most 15 UTA. */
  presumedExpensesClp: number;
  /** 770: APV régimen B deposited by a worker independiente, declared in the box. */
  apvClp: number;
  /** 110: gross − presumed expenses − 770. */
  netClp: number;
  /** 198: what the payers withheld plus what the issuer paid in his F29. */
  retentionClp: number;
};

/** Why an item of a non-resident window enters no code (see the header's «Residency»). */
export type F22ExcludedReason = "nonresident" | "treaty_art13_8" | "fund_unico_withheld" | "withheld_at_source" | "no_igc";

export type F22ExcludedKind =
  | "us_salary"
  | "foreign_dividends"
  | "foreign_interest"
  | "foreign_shares"
  /** US-listed option premiums (net received), foreign-source. */
  | "options"
  | "usd_fx"
  | "crypto"
  | "fund_redemptions"
  | "fund_distributions"
  | "chile_interest"
  | "mortgage_interest"
  | "apv"
  | "property_tax_credit";

/** An item of a non-resident window the return does not declare: what it is, why, and how much (pesos, as the resident chain would have read it). */
export type F22ExcludedItem = {
  kind: F22ExcludedKind;
  reason: F22ExcludedReason;
  clp: number;
  /** Lines, sales, stubs… behind the amount (0 for a yearly DJ figure). */
  count: number;
  window: DateWindow;
};

/** The non-resident part of a year: the Impuesto Adicional on the Chilean-source items of its window. */
export type F22NonresidentPart = {
  window: DateWindow;
  rentals: F22Rentals;
  /** Art. 107 sales of the window at the general-rule cost (N°7), the 10 % único withheld by the broker (N°6). */
  art107: Art107TaxYear;
  /** 1849 / 955 / 158 / 32 / 34 and the art. 107 codes of this part. */
  codes: F22Codes;
  excluded: F22ExcludedItem[];
  /** Whether anything of the window enters a code (rent, an art. 107 sale). */
  taxComputed: boolean;
};

/** The declared residency the draft was built on. */
export type F22Residency = {
  regime: F22Regime;
  /** The declared residency of the income year (`residencyForIncomeYear`). */
  year: YearResidency;
  /** The assumption the return states when a residency is declared; null when nothing is (Chile, as always). */
  assumption: string | null;
  /** The resident part's window (the whole year, or through the declared day); null for a non-resident year. */
  residentWindow: DateWindow | null;
};

export type F22Draft = {
  taxYear: number;
  incomeYear: number;
  /** The income year has not closed: 31-December rates and the December reajuste are the latest published. */
  provisional: boolean;
  base: F22DraftBase;
  /** Resident, non-resident or the departure year (`taxResidency.ts`). */
  regime: F22Regime;
  residency: F22Residency;
  /** The non-resident part (a non-resident year, or the departure year's second part); null for a resident year. */
  nonresident: F22NonresidentPart | null;
  /** What the non-resident part does not declare (`nonresident.excluded`, or empty). */
  excluded: F22ExcludedItem[];
  /** Whether the tax chain ran (it needs a base). */
  taxComputed: boolean;
  utaClp: number;
  yearEndObservado: number;
  filed: F22Codes | null;
  salary: PayrollTaxYear;
  fees: F22FeesBox | null;
  /** The UTA the chain used is the latest month's, not December's (open year). */
  utaProvisional: boolean;
  informed: Record<number, number>;
  draft: F22Codes;
  crypto: CryptoYearTaxResult;
  cryptoInformedSalesClp: number | null;
  dividends: F22DividendLine[];
  foreignShares: ForeignShareYearResult;
  /** First-category tax on foreign share gains (line 58) and its credit (code 1914) — equal, net zero. */
  foreignSharesIdpcClp: number;
  /** Codes the draft estimated from the ledger because no third party had reported them yet. */
  estimatedCodes: number[];
  lossOffset: F22LossOffset;
  /** Foreign share sales netted among themselves (a loss offsets nothing else). */
  foreignShareOffset: F22OffsetBalance;
  /** Art. 107 instruments' sales and the codes they give (1809 … 1830). */
  art107: Art107TaxYear;
  /** The art. 107 instruments' distributions (dividends afectos al IGC) and their sum, behind the 105 estimate. */
  art107Distributions: Art107Distribution[];
  art107DistributionsClp: number;
  /** DJ 1891's «Monto Total Ventas» (the broker's sales of shares and cuotas); null without the DJ. */
  art107InformedSalesClp: number | null;
  /** DJ 1922's art. 107 difference (section B1, actualizada); null without the DJ. */
  art107InformedResultClp: number | null;
  /** The exchange result on the dollars bought with pesos, under the route and posture the draft took (report-only). */
  usdFx: UsdFxYearTaxResult;
  /** Route `idpc_1901`: first-category tax on 1901 (line 58 d) and its line-5 credit — equal, net zero; 0 on the other route. */
  usdFxIdpcClp: number;
  /** The year's rents by place: taxable (1849 → 955, credit 1637) and DFL-2 exempt (not declared). */
  rentals: F22Rentals;
  /** 1637 before its cap (the contribuciones on the taxable places) and the cap; null when no taxable rent. */
  propertyTaxCredit: { paidClp: number; capClp: number; creditClp: number } | null;
  /** A salary earned abroad (US pay stubs): 1030 (línea 13), its credit (748 / 1018, líneas 14 / 45), `f22/foreignIncome`. */
  foreignSalary: F22ForeignSalary;
  /** The foreign salary's credit: before the IGC cap, the cap and what 1018 took; null without one. */
  foreignSalaryCredit: { creditClp: number; capClp: number; appliedClp: number } | null;
  /** A foreign broker's interest, in 1104. */
  foreignInterest: F22ForeignInterest;
};

/** What {@link buildF22Draft} may be told beyond the year: the dollars' exchange-result parameters and its loader (tests). */
export type F22DraftOptions = {
  usdFx?: {
    route?: UsdFxRoute;
    posture?: UsdFxPosture;
    purchaseCost?: UsdPurchaseCost;
    /** The tax-lot disposals; the DB walk (`usdCashTaxDisposals`) unless injected. */
    load?: UsdFxDisposalLoader;
  };
};
