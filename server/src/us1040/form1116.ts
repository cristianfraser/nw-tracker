/**
 * Form 1116 (foreign tax credit), passive category, the pure part (docs/us-1040-readings.md §6).
 *
 * - The accrual election is assumed made ({@link FOREIGN_TAXES_ACCRUED_ELECTION}): Pub. 514 «Choosing
 *   to take credit in the year taxes accrue»; binding for all later years.
 * - Limit: US tax before credits × foreign-source passive taxable income ÷ total taxable income
 *   (§904(a)); zero when the category's net income is zero or negative, never above the whole tax.
 * - Excess taxes carry back one year (NOT modelled) and forward ten (§904(c): «the 10 years
 *   following»). Current-year taxes are used before carryovers, oldest carryover first (Reg.
 *   §1.904-2(c)(1) as remembered — UNVERIFIED against the text).
 * - No credit against the net investment income tax (Reg. §1.1411-1(e)): this module's credit
 *   reduces the income tax only.
 *
 * Which Chilean taxes are creditable is {@link classifyChileanTaxes}'s (the readings doc §6).
 */

/** Pub. 514: the accrued-taxes election, assumed made on the first original return and binding after. */
export const FOREIGN_TAXES_ACCRUED_ELECTION = true;
/** §904(c): years an excess credit carries forward. */
export const FTC_CARRYFORWARD_YEARS = 10;

export type FtcCarryover = { taxYear: number; amountUsd: number };

export type Form1116Input = {
  taxYear: number;
  /** Foreign-source passive gross income of the year (rents are passive for a passive landlord; Pub. 514). */
  foreignPassiveGrossUsd: number;
  /** Deductions allocable to it (Schedule E expenses of the foreign rentals, …). */
  foreignPassiveDeductionsUsd: number;
  /** Form 1040 line 15. */
  taxableIncomeUsd: number;
  /** The US income tax before credits that the limit applies to (line 16 plus the other taxes the credit may offset, as the caller composes it). */
  usTaxBeforeCreditsUsd: number;
  /** Creditable foreign taxes accrued for the year in this category (see {@link classifyChileanTaxes}). */
  taxesAccruedUsd: number;
  /** Excess taxes carried in, oldest first. */
  carryoversIn: readonly FtcCarryover[];
};

export type Form1116Result = {
  foreignPassiveTaxableIncomeUsd: number;
  /** The fraction applied, capped at 1 (0 when the foreign income is not positive). */
  limitFraction: number;
  limitUsd: number;
  /** Current-year taxes plus the carryovers still alive. */
  availableUsd: number;
  creditAllowedUsd: number;
  /** Excess carried out: the unused current-year taxes and carryovers still alive, with their year. */
  carryoversOut: FtcCarryover[];
  /** Carryovers that expired unused this year (older than ten years). */
  expiredUsd: number;
};

export function form1116(input: Form1116Input): Form1116Result {
  if (!FOREIGN_TAXES_ACCRUED_ELECTION) throw new Error("Form 1116: the paid-basis election is not modelled");
  const net = input.foreignPassiveGrossUsd - input.foreignPassiveDeductionsUsd;
  const limitFraction = net > 0 && input.taxableIncomeUsd > 0 ? Math.min(1, net / input.taxableIncomeUsd) : 0;
  const limitUsd = Math.max(0, input.usTaxBeforeCreditsUsd) * limitFraction;

  const alive: FtcCarryover[] = [];
  let expiredUsd = 0;
  for (const c of input.carryoversIn) {
    // Carried to the ten years following the year they arose.
    if (input.taxYear - c.taxYear > FTC_CARRYFORWARD_YEARS) expiredUsd += c.amountUsd;
    else if (c.amountUsd > 0) alive.push({ ...c });
  }
  const current: FtcCarryover = { taxYear: input.taxYear, amountUsd: Math.max(0, input.taxesAccruedUsd) };
  // Current-year taxes first, then the carryovers oldest first.
  const order = [current, ...[...alive].sort((a, b) => a.taxYear - b.taxYear)];
  let room = limitUsd;
  let creditAllowedUsd = 0;
  for (const bucket of order) {
    const used = Math.min(room, bucket.amountUsd);
    bucket.amountUsd -= used;
    room -= used;
    creditAllowedUsd += used;
  }
  return {
    foreignPassiveTaxableIncomeUsd: net,
    limitFraction,
    limitUsd,
    availableUsd: order.reduce((a, b) => a + b.amountUsd, 0) + creditAllowedUsd,
    creditAllowedUsd,
    carryoversOut: order.filter((b) => b.amountUsd > 0).sort((a, b) => a.taxYear - b.taxYear),
    expiredUsd,
  };
}

export type ChileanTaxItem =
  /** Impuesto Adicional on rent paid by a non-resident of Chile (F22 code 34 of the same income year). */
  | "adicional_on_rent"
  /** The 10 % único on an ETF or fund sale (art. 107 / Ley 20.712). */
  | "unico_on_etf_sale"
  | "unico_on_fund_redemption"
  | "unico_on_fund_distribution";

export type ClassifiedChileanTax = {
  item: ChileanTaxItem;
  amountUsd: number;
  creditable: boolean;
  /** True when the reading rests on a point the readings doc lists as UNVERIFIED. */
  unverified: boolean;
  /** True when claiming it is a treaty-based position that Form 8833 may have to disclose. */
  form8833: boolean;
  reason: string;
};

/**
 * The Chilean taxes a US resident may credit on Form 1116 (docs/us-1040-readings.md §6):
 * - the Impuesto Adicional on rent: YES — treaty Art. 23(1) (as restated by the 2023 exchange of
 *   notes) treats the Income Tax Act's taxes as income taxes and Reg. §1.901-2(a)(1)(iii) accepts a
 *   treaty-listed levy; Notices 2023-55 / 2023-80 relief covers 2024 and 2025 as well. Form 8833
 *   likely; subject to §904.
 * - the 10 % único on an ETF sale or fund redemption: NO — treaty Art. 13(6)(c) / 13(8) leave the gain
 *   to the residence State, so Chile's tax exceeds the treaty (not a compulsory payment, Reg.
 *   §1.901-2(e)(5)), and the gain is US-source for a US resident (§865(a)(1)): no foreign income to
 *   credit against.
 * - the único on a fund's distributions: YES, a foreign passive dividend taxed within the treaty
 *   (Art. 10 caps at 15 %, the único is 10 %) — UNVERIFIED: whether a fondo's distribution is a
 *   dividend under the convention and the único an income tax in the US sense are not settled.
 */
export function classifyChileanTaxes(items: readonly { item: ChileanTaxItem; amountUsd: number }[]): {
  creditableUsd: number;
  classified: ClassifiedChileanTax[];
} {
  const classified = items.map((i): ClassifiedChileanTax => {
    switch (i.item) {
      case "adicional_on_rent":
        return { ...i, creditable: true, unverified: false, form8833: true, reason: "Treaty Art. 23(1) + Reg. §1.901-2(a)(1)(iii); Notices 2023-55 / 2023-80 relief covers 2024-2025" };
      case "unico_on_etf_sale":
      case "unico_on_fund_redemption":
        return { ...i, creditable: false, unverified: false, form8833: false, reason: "Treaty Art. 13 leaves the gain to the residence State; US-source gain under §865(a)(1): no foreign income to credit" };
      case "unico_on_fund_distribution":
        return { ...i, creditable: true, unverified: true, form8833: false, reason: "A foreign passive dividend taxed within Art. 10's 15 % cap; whether the fondo's distribution is a dividend under the convention is UNVERIFIED" };
    }
  });
  return { creditableUsd: classified.filter((c) => c.creditable).reduce((a, c) => a + c.amountUsd, 0), classified };
}
