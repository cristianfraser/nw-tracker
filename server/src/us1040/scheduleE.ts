/**
 * Schedule E (Part I) for a foreign rental property of a US resident, the pure part: a place's
 * rents and expenses in dollars become the form's lines, with the depreciation the ADS schedule
 * gives (docs/us-1040-readings.md §4). Every peso amount is converted by the caller at the rate of
 * its own day (`fx_daily` on or before, the 1040's one rule); this module does no conversion.
 *
 * Readings built (cited in the readings doc, every one a stated assumption where it is one):
 * - ADS, 30 years, straight line, mid-month: a rental used predominantly outside the US must use
 *   the Alternative Depreciation System (§168(g)(1)(A)); residential rental property is 30 years
 *   (§168(g)(2)(C)(iii) as amended by P.L. 115-97; Pub. 527 Table 2-1). Land is not depreciable.
 * - A former home converted to rental: basis is the lesser of adjusted basis and fair market value on
 *   the conversion day, placed in service that day (Reg. §1.168(i)-4(b)(1); Pub. 527).
 * - A rental that was one before the owner became a US person (Centro): no authority either way
 *   ({@link PRE_RESIDENCY_DEPRECIATION}).
 * - Expenses (Pub. 527 ch. 1): management fees (the agency's commission), mortgage interest, the
 *   fire insurance, utilities and the building's common expenses the owner pays, and the foreign
 *   real property tax (contribuciones): §164(b)(6)'s bar on deducting foreign real property taxes
 *   does not reach taxes paid in carrying on an activity described in §212 (§164(a), last sentence).
 *   The loan's life (desgravamen) insurance is not deducted: premiums on life insurance of which
 *   the borrower is not the owner-beneficiary of the property are not an expense of the rental
 *   (§264(a)(1) in spirit; not a Schedule E line).
 * - Not modelled: the exchange gain or loss on repaying the UF-indexed loan (§988); a quarterly
 *   rate convention; the acquisition costs (notary, taxes) in the basis — the ledger records none.
 */
import type { DateWindow } from "../dateWindow.js";
import { inDateWindow } from "../dateWindow.js";
import { loanPaymentFacts } from "../taxFacts/loans.js";
import { propertyAppraisalOn, propertyFacts } from "../taxFacts/properties.js";
import { rentalFacts, type PlaceBillFact } from "../taxFacts/rentals.js";

/** Converts `amount` of `currency` (`clp`, `uf`, `usd`) on `ymd` into dollars. The caller's (R2a's) converter. */
export type UsdAt = (amount: number, currency: string, ymd: string) => number;

/** ADS recovery period of residential rental property: §168(g)(2)(C)(iii); Pub. 527 Table 2-1. */
export const ADS_RECOVERY_YEARS = 30;

/** The share of a purchase price that is land (not depreciable). An assumption: the ledger records no split (the usual ratio of a property tax assessment would be the source). */
export const LAND_SHARE = 0.2;

/**
 * How a rental held before the owner became a US person is depreciated. UNVERIFIED either way
 * (docs/us-1040-readings.md §4): no authority addresses a foreign rental of a new US resident.
 * - `from_placed_in_service` (built): the original placed-in-service date stands; allowable
 *   depreciation of the earlier years reduces basis, so the first US year is year N of 30 on the
 *   historic dollar cost.
 * - `fresh_on_arrival`: the property is placed in service on the first day of the US window at the
 *   lesser of its adjusted basis (cost less the allowable depreciation until then) and its value
 *   that day (building share), a new 30 years. By analogy to Reg. §1.168(i)-4's conversion rule.
 */
export type PreResidencyDepreciation = "from_placed_in_service" | "fresh_on_arrival";
export const PRE_RESIDENCY_DEPRECIATION: PreResidencyDepreciation = "from_placed_in_service";

export type ScheduleELaw = { adsRecoveryYears: number; landShare: number; preResidencyDepreciation: PreResidencyDepreciation };
export const SCHEDULE_E_LAW: ScheduleELaw = {
  adsRecoveryYears: ADS_RECOVERY_YEARS,
  landShare: LAND_SHARE,
  preResidencyDepreciation: PRE_RESIDENCY_DEPRECIATION,
};

/** What the depreciation needs about the property. */
export type ScheduleEDepreciationInput = {
  /** The day the property started earning rent (or was converted to a rental). */
  placedInServiceDate: string;
  /** Land + building basis in dollars when placed in service: the cost at the purchase day's rate, or for a converted home the lesser of that cost and its value on the conversion day. */
  basisUsd: number;
  /** `purchase_cost` or `lesser_of_cost_and_value_at_conversion`: where `basisUsd` comes from. */
  basisOrigin: "purchase_cost" | "lesser_of_cost_and_value_at_conversion";
  /** The first day the owner was a US person (the residency's start, not the tax year's): a property placed in service before it is a pre-residency rental. */
  usPersonSince: string;
  /** The property's value (land + building) in dollars on `usPersonSince`; needed for `fresh_on_arrival` when it was placed in service earlier. */
  valueAtUsPersonSinceUsd: number | null;
};

/** The bill kinds that become Schedule E lines, in dollars, summed over the service window. */
export type ScheduleEExpensesUsd = {
  /** Line 11: the agency's commission. */
  managementFees: number;
  /** Line 12: interest paid to the lender. */
  mortgageInterest: number;
  /** Line 9: the loan's fire insurance. */
  insurance: number;
  /** Line 16: contribuciones. */
  taxes: number;
  /** Line 17: electricity, gas, water, internet the owner pays. */
  utilities: number;
  /** Line 19: the building's gastos comunes. */
  other: number;
};

export type ScheduleEPlaceInput = {
  slug: string;
  label: string;
  /** The US-person part of the tax year the lines are for. */
  window: DateWindow;
  /** Line 3: rents received in the window. */
  rentsUsd: number;
  expensesUsd: ScheduleEExpensesUsd;
  depreciation: ScheduleEDepreciationInput;
};

export type ScheduleEDepreciationResult = {
  /** The building basis depreciated (after the land share). */
  buildingBasisUsd: number;
  /** The day the depreciation runs from (the placed-in-service date, or the first day as a US person under `fresh_on_arrival`). */
  startDate: string;
  reading: PreResidencyDepreciation | "placed_in_window";
  /** The month-and-fractions of the recovery period inside the window (mid-month convention: the first month counts half). */
  monthsInWindow: number;
  amountUsd: number;
};

export type ScheduleEPlaceLines = {
  slug: string;
  label: string;
  /** Schedule E line numbers: 3 rents, 9 insurance, 11 management fees, 12 mortgage interest, 16 taxes, 17 utilities, 18 depreciation, 19 other, 20 total expenses, 21 income or loss. */
  lines: { l3: number; l9: number; l11: number; l12: number; l16: number; l17: number; l18: number; l19: number; l20: number; l21: number };
  depreciation: ScheduleEDepreciationResult;
};

export type ScheduleEResult = { places: ScheduleEPlaceLines[]; netUsd: number };

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Position on the month axis: months since year 0, the day as a fraction of its month (start of day). */
function monthCoord(ymd: string): number {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  const d = Number(ymd.slice(8, 10));
  return y * 12 + (m - 1) + (d - 1) / daysInMonth(y, m);
}

/** End of `ymd`'s day on the same axis. */
function monthCoordEndOfDay(ymd: string): number {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  return monthCoord(ymd) + 1 / daysInMonth(y, m);
}

/** The months of an ADS recovery period (starting mid-month in `startDate`'s month) that fall inside `window`. */
function recoveryMonthsInWindow(startDate: string, years: number, window: DateWindow): number {
  const y = Number(startDate.slice(0, 4));
  const m = Number(startDate.slice(5, 7));
  const start = y * 12 + (m - 1) + 0.5;
  const end = start + years * 12;
  return Math.max(0, Math.min(end, monthCoordEndOfDay(window.throughYmd)) - Math.max(start, monthCoord(window.fromYmd)));
}

/**
 * Straight-line ADS depreciation of `buildingBasisUsd` placed in service in `startDate`'s month
 * (mid-month convention: the month counts as half), for the part of the recovery period inside
 * `window`. A partial year prorates by the days of the window.
 */
export function adsDepreciation(buildingBasisUsd: number, startDate: string, years: number, window: DateWindow): { monthsInWindow: number; amountUsd: number } {
  const monthsInWindow = recoveryMonthsInWindow(startDate, years, window);
  return { monthsInWindow, amountUsd: (buildingBasisUsd * monthsInWindow) / (years * 12) };
}

/** The depreciation of one place in the window under `law`. */
export function scheduleEDepreciation(d: ScheduleEDepreciationInput, window: DateWindow, law: ScheduleELaw = SCHEDULE_E_LAW): ScheduleEDepreciationResult {
  const keep = 1 - law.landShare;
  const placedBefore = d.placedInServiceDate < d.usPersonSince;
  if (placedBefore && law.preResidencyDepreciation === "fresh_on_arrival") {
    if (d.valueAtUsPersonSinceUsd == null) throw new Error("Schedule E: fresh_on_arrival needs the property's value on the first day as a US person");
    // Adjusted basis = building cost less what was allowable until the day before the residency.
    const before: DateWindow = { fromYmd: "0001-01-01", throughYmd: dayBefore(d.usPersonSince) };
    const building = d.basisUsd * keep;
    const allowable = adsDepreciation(building, d.placedInServiceDate, law.adsRecoveryYears, before).amountUsd;
    const buildingBasisUsd = Math.min(building - allowable, d.valueAtUsPersonSinceUsd * keep);
    const { monthsInWindow, amountUsd } = adsDepreciation(buildingBasisUsd, d.usPersonSince, law.adsRecoveryYears, window);
    return { buildingBasisUsd, startDate: d.usPersonSince, reading: "fresh_on_arrival", monthsInWindow, amountUsd };
  }
  const buildingBasisUsd = d.basisUsd * keep;
  const { monthsInWindow, amountUsd } = adsDepreciation(buildingBasisUsd, d.placedInServiceDate, law.adsRecoveryYears, window);
  return {
    buildingBasisUsd,
    startDate: d.placedInServiceDate,
    reading: placedBefore ? "from_placed_in_service" : "placed_in_window",
    monthsInWindow,
    amountUsd,
  };
}

function dayBefore(ymd: string): string {
  const t = Date.parse(`${ymd}T00:00:00Z`) - 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** One place's Schedule E lines. */
export function scheduleEForPlace(input: ScheduleEPlaceInput, law: ScheduleELaw = SCHEDULE_E_LAW): ScheduleEPlaceLines {
  const e = input.expensesUsd;
  const depreciation = scheduleEDepreciation(input.depreciation, input.window, law);
  const l18 = depreciation.amountUsd;
  const l20 = e.insurance + e.managementFees + e.mortgageInterest + e.taxes + e.utilities + l18 + e.other;
  return {
    slug: input.slug,
    label: input.label,
    lines: {
      l3: input.rentsUsd,
      l9: e.insurance,
      l11: e.managementFees,
      l12: e.mortgageInterest,
      l16: e.taxes,
      l17: e.utilities,
      l18,
      l19: e.other,
      l20,
      l21: input.rentsUsd - l20,
    },
    depreciation,
  };
}

/** Every place's lines and the net (the Schedule E total, line 26 / Schedule 1 line 5 before the passive-loss limit). */
export function scheduleE(inputs: readonly ScheduleEPlaceInput[], law: ScheduleELaw = SCHEDULE_E_LAW): ScheduleEResult {
  const places = inputs.map((i) => scheduleEForPlace(i, law));
  return { places, netUsd: places.reduce((a, p) => a + p.lines.l21, 0) };
}

const UTILITY_KINDS: ReadonlySet<string> = new Set(["electricidad", "gas", "water", "internet"]);

function billLine(b: PlaceBillFact): keyof ScheduleEExpensesUsd | null {
  const k = b.category;
  if (k === "management_fee") return "managementFees";
  if (k === "contribuciones") return "taxes";
  if (k === "gastos_comunes") return "other";
  if (k != null && UTILITY_KINDS.has(k)) return "utilities";
  if (k === "kwh" && b.amountClp === 0) return null;
  throw new Error(`Schedule E: bill ${b.entryId} of kind '${k}' has no Schedule E line`);
}

/**
 * The Schedule E inputs of the rental places with rent in `window` (the US-person part of the tax
 * year), converting each peso or UF amount at its own day through `usdAt`. A place's expenses are
 * those dated from the day it started earning rent; a bill is dated on its month's last day (the
 * bill month), so a payment made just before the window or the rental's first day can land inside
 * it. The mortgage interest and fire insurance come from the loan's payments dated in the service
 * window; the life insurance is left out (see the module note).
 */
export function scheduleEInputs(window: DateWindow, usdAt: UsdAt, opts?: { usPersonSince?: string }): ScheduleEPlaceInput[] {
  // Default: the window opens on the day the person became a US person (right for the arrival year only).
  const usPersonSince = opts?.usPersonSince ?? window.fromYmd;
  const properties = propertyFacts();
  return rentalFacts(window).map((place): ScheduleEPlaceInput => {
    const property = properties.find((p) => p.places.some((pl) => pl.placeId === place.placeId));
    if (!property) throw new Error(`Schedule E: place ${place.slug} is not linked to a property account`);
    const purchase = property.purchase;
    const placed = property.placedInServiceDate;
    if (!purchase || !placed) throw new Error(`Schedule E: property of ${place.slug} has no purchase or no first rent`);
    const serviceFrom = placed > window.fromYmd ? placed : window.fromYmd;
    const service: DateWindow = { fromYmd: serviceFrom, throughYmd: window.throughYmd };

    const expenses: ScheduleEExpensesUsd = { managementFees: 0, mortgageInterest: 0, insurance: 0, taxes: 0, utilities: 0, other: 0 };
    for (const b of place.bills) {
      if (!inDateWindow(b.date, service)) continue;
      const line = billLine(b);
      if (line) expenses[line] += usdAt(b.amountClp, "clp", b.date);
    }
    if (property.loanAccountId != null) {
      for (const p of loanPaymentFacts(service, property.loanAccountId)) {
        expenses.mortgageInterest += usdAt(p.interest ?? 0, p.currency, p.date);
        expenses.insurance += usdAt(p.insuranceFire ?? 0, p.currency, p.date);
      }
    }
    const rentsUsd = place.rentCredits.filter((c) => inDateWindow(c.date, service)).reduce((a, c) => a + usdAt(c.amountClp, "clp", c.date), 0);

    const costUsd = usdAt(purchase.value, purchase.currency, purchase.date);
    let basisUsd = costUsd;
    let basisOrigin: ScheduleEDepreciationInput["basisOrigin"] = "purchase_cost";
    if (property.conversion) {
      const a = property.conversion.appraisal;
      const valueUsd = usdAt(a.value, a.currency, property.conversion.date);
      basisUsd = Math.min(costUsd, valueUsd);
      basisOrigin = "lesser_of_cost_and_value_at_conversion";
    }
    let valueAtUsPersonSinceUsd: number | null = null;
    if (placed < usPersonSince) {
      const a = propertyAppraisalOn(property.propertyAccountId, usPersonSince);
      if (a) valueAtUsPersonSinceUsd = usdAt(a.value, a.currency, usPersonSince);
    }
    return {
      slug: place.slug,
      label: place.label,
      window,
      rentsUsd,
      expensesUsd: expenses,
      depreciation: { placedInServiceDate: placed, basisUsd, basisOrigin, usPersonSince, valueAtUsPersonSinceUsd },
    };
  });
}
