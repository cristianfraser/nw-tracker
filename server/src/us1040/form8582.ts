/**
 * Form 8582 (passive activity loss limitations) for rental real estate in which the owner actively
 * participated (§469(i); docs/us-1040-readings.md §5), the pure part. The special allowance offsets
 * up to US$25.000 of non-passive income with rental losses, reduced by 50 % of the MAGI over
 * US$100.000 (zero at 150.000). A foreign rental is not carved out; an agency does not defeat active
 * participation (≥ 10 % ownership plus management decisions). Losses that do not pass are suspended
 * and carried forward (§469(b)); a net gain absorbs them first. Released on a full taxable
 * disposition (§469(g)) — not modelled here.
 *
 * Statuses: single and married filing jointly share the US$25.000 / 100.000–150.000 band; a married
 * person filing separately who lived apart all year has half of both (§469(i)(5)(B)); one who lived
 * with the spouse has none — not offered (the law table models single and joint only).
 */

export type Form8582Status = "single" | "married_jointly" | "married_separate_lived_apart";

/** §469(i)(2): the maximum offset. */
export const PASSIVE_ALLOWANCE_USD = 25_000;
/** §469(i)(3)(A): the allowance falls by this share of the MAGI above the threshold. */
export const PASSIVE_ALLOWANCE_PHASEOUT_RATE = 0.5;
/** §469(i)(3)(A): the MAGI threshold. */
export const PASSIVE_ALLOWANCE_MAGI_THRESHOLD_USD = 100_000;

export type Form8582Input = {
  status: Form8582Status;
  /** Modified AGI: AGI before the passive losses, taxable Social Security and the other §469(i)(3)(E) adjustments. */
  magiUsd: number;
  /** The year's net of all rental real estate with active participation (Schedule E line 21 total): negative is a loss. */
  rentalNetUsd: number;
  /** Suspended losses carried in from earlier years, as a positive amount. */
  priorSuspendedLossUsd: number;
};

export type Form8582Result = {
  /** The special allowance after the MAGI phase-out. */
  allowanceUsd: number;
  /** The allowance before it (status-dependent). */
  allowanceBeforePhaseOutUsd: number;
  /** The loss to be limited: this year's loss plus the carried loss not absorbed by this year's gain (positive). */
  limitedLossUsd: number;
  /** The loss allowed this year (positive). */
  allowedLossUsd: number;
  /** The loss suspended into next year (positive). */
  suspendedLossUsd: number;
  /** The carried loss a net gain absorbed this year. */
  priorLossAbsorbedUsd: number;
  /** What the rental adds to income: the net gain less the absorbed carry, or minus the allowed loss (Schedule 1 line 5). */
  includedInIncomeUsd: number;
};

/** The special allowance for `magiUsd` (§469(i)(2)–(3), §469(i)(5)(B) for MFS who lived apart). */
export function passiveLossAllowanceUsd(status: Form8582Status, magiUsd: number): { before: number; after: number } {
  const half = status === "married_separate_lived_apart";
  const before = half ? PASSIVE_ALLOWANCE_USD / 2 : PASSIVE_ALLOWANCE_USD;
  const threshold = half ? PASSIVE_ALLOWANCE_MAGI_THRESHOLD_USD / 2 : PASSIVE_ALLOWANCE_MAGI_THRESHOLD_USD;
  const reduction = PASSIVE_ALLOWANCE_PHASEOUT_RATE * Math.max(0, magiUsd - threshold);
  return { before, after: Math.max(0, before - reduction) };
}

export function form8582(input: Form8582Input): Form8582Result {
  if (input.priorSuspendedLossUsd < 0) throw new Error("Form 8582: the carried loss is a positive amount");
  const { before, after } = passiveLossAllowanceUsd(input.status, input.magiUsd);
  const net = input.rentalNetUsd;
  const absorbed = net > 0 ? Math.min(input.priorSuspendedLossUsd, net) : 0;
  const limitedLossUsd = (net < 0 ? -net : 0) + input.priorSuspendedLossUsd - absorbed;
  const allowedLossUsd = Math.min(limitedLossUsd, after);
  return {
    allowanceBeforePhaseOutUsd: before,
    allowanceUsd: after,
    limitedLossUsd,
    allowedLossUsd,
    suspendedLossUsd: limitedLossUsd - allowedLossUsd,
    priorLossAbsorbedUsd: absorbed,
    includedInIncomeUsd: (net > 0 ? net - absorbed : 0) - allowedLossUsd,
  };
}
