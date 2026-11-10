/**
 * Form 8621 Part IV (mark-to-market election, §1296) for each PFIC holding, the pure part, and the
 * loader that builds its inputs from the ledger (docs/us-1040-readings.md §7).
 *
 * Mark to market: at the year's end the excess of fair market value over the adjusted basis is
 * ordinary income (§1296(a)(1)), added to the basis; a decline is deductible only up to the
 * unreversed inclusions (§1296(a)(2)), taken off the basis. A sale: gain ordinary; loss ordinary up to
 * the unreversed inclusions, the rest capital (Reg. §1.1296-1(c)(4)). The result goes to Schedule 1
 * line 8z. An MTM-elected holding always files (the US$25.000 exception of Reg. §1.1298-1(c)(2) is
 * for §1291 funds only).
 *
 * Flagged, not computed: {@link Form8621Flags}.
 */
import type { DateWindow } from "../dateWindow.js";
import { addDaysIso } from "nw-tracker-contracts";
import { accountProfileOptional } from "../accountProfile.js";
import { db } from "../db.js";
import { holdingPositionsOn, holdingTransactionFacts } from "../taxFacts/fundHoldings.js";
import { isPficInstrument } from "./pfic.js";
import type { UsdAt } from "./scheduleE.js";

/**
 * Reg. §1.1296-1(d)(5)(i): on becoming a US person the adjusted basis of section 1296 stock owned on
 * «the first day of such taxable year» is the GREATER of fair market value or adjusted basis. Read
 * literally that day is January 1 of the arrival year (`first_day_of_tax_year`, built); for a
 * mid-year arrival the reading is UNVERIFIED and the alternative is the residency's first day
 * (`residency_start`).
 */
export type PficArrivalBasisDay = "first_day_of_tax_year" | "residency_start";
export const PFIC_ARRIVAL_BASIS_DAY: PficArrivalBasisDay = "first_day_of_tax_year";

export type Form8621Event =
  | { kind: "acquire"; date: string; units: number; costUsd: number }
  | { kind: "dispose"; date: string; units: number; proceedsUsd: number };

/** The roll-forward state of one holding between years. */
export type Form8621State = { units: number; adjustedBasisUsd: number; unreversedInclusionsUsd: number };

export type Form8621Arrival = {
  /** Units held on the day before the residency starts. */
  startUnits: number;
  /** Their historic cost in dollars (each purchase at its own day's rate). */
  startCostBasisUsd: number;
  /** Their value in dollars on the arrival basis day ({@link PFIC_ARRIVAL_BASIS_DAY}), at that day's rate. */
  startFmvUsd: number;
};

export type Form8621YearInput = {
  accountId: number;
  label: string;
  taxYear: number;
  /** The first year as a US person: the start state is {@link Form8621Arrival}'s. Later years take the previous year's state. */
  arrival: Form8621Arrival | null;
  /** Purchases and sales as a US person in the year (the residency window), in date order. */
  events: Form8621Event[];
  /** Units and fair market value (dollars at the year-end rate) at the year's last day. */
  unitsYearEnd: number;
  fmvYearEndUsd: number;
};

export type Form8621Flags = {
  /** The fund was held before the election year (before becoming a US person): Part V's §1291 first-year coordination may apply — the largest open risk. Not computed. */
  partVPossible: boolean;
  /** The holding is assumed to be marketable stock (§1296(e); Reg. §1.1296-2(d) for a fondo, a qualified exchange for the ETF): UNVERIFIED. */
  marketableAssumed: true;
  /** The fondo is assumed to be a «foreign corporation» for PFIC purposes: UNVERIFIED entity classification. */
  foreignCorporationAssumed: true;
};

export type Form8621Disposal = {
  date: string;
  units: number;
  proceedsUsd: number;
  /** The pro rata adjusted basis sold. */
  basisUsd: number;
  ordinaryGainUsd: number;
  ordinaryLossUsd: number;
  /** The loss above the unreversed inclusions: capital. */
  capitalLossUsd: number;
};

export type Form8621Result = {
  accountId: number;
  label: string;
  taxYear: number;
  startBasisUsd: number;
  startUnits: number;
  /** The adjusted basis after purchases and sales, before the year-end adjustment. */
  basisBeforeMarkUsd: number;
  fmvYearEndUsd: number;
  /** Part IV: the inclusion at the year's end (ordinary income). */
  inclusionUsd: number;
  /** The deduction allowed (up to the unreversed inclusions). */
  deductionUsd: number;
  /** A decline above the unreversed inclusions: allowed nowhere. */
  disallowedLossUsd: number;
  disposals: Form8621Disposal[];
  /** Σ ordinary income for Schedule 1 line 8z: the inclusion and ordinary gains less the deduction and ordinary losses. */
  ordinaryIncomeUsd: number;
  /** Capital losses on sales (above the unreversed inclusions). */
  capitalLossUsd: number;
  stateOut: Form8621State;
  flags: Form8621Flags;
};

/** One holding-year of Part IV from the previous year's state (`null` for a holding not held yet). */
export function form8621Year(input: Form8621YearInput, stateIn: Form8621State | null): Form8621Result {
  let state: Form8621State;
  if (input.arrival) {
    if (stateIn) throw new Error("Form 8621: a first US year takes no state carried in");
    // Greater of fair market value and adjusted basis (Reg. §1.1296-1(d)(5)(i)).
    state = { units: input.arrival.startUnits, adjustedBasisUsd: Math.max(input.arrival.startFmvUsd, input.arrival.startCostBasisUsd), unreversedInclusionsUsd: 0 };
  } else {
    state = stateIn ? { ...stateIn } : { units: 0, adjustedBasisUsd: 0, unreversedInclusionsUsd: 0 };
  }
  const startBasisUsd = state.adjustedBasisUsd;
  const startUnits = state.units;
  const disposals: Form8621Disposal[] = [];
  for (const e of input.events) {
    if (e.kind === "acquire") {
      state.units += e.units;
      state.adjustedBasisUsd += e.costUsd;
      continue;
    }
    if (e.units > state.units + 1e-9) throw new Error(`Form 8621: ${input.label} sells ${e.units} units on ${e.date} with ${state.units} held`);
    const share = state.units > 0 ? e.units / state.units : 0;
    const basisUsd = state.adjustedBasisUsd * share;
    const unreversedSold = state.unreversedInclusionsUsd * share;
    const result = e.proceedsUsd - basisUsd;
    disposals.push({
      date: e.date,
      units: e.units,
      proceedsUsd: e.proceedsUsd,
      basisUsd,
      ordinaryGainUsd: Math.max(0, result),
      ordinaryLossUsd: result < 0 ? Math.min(-result, unreversedSold) : 0,
      capitalLossUsd: result < 0 ? Math.max(0, -result - unreversedSold) : 0,
    });
    state.units -= e.units;
    state.adjustedBasisUsd -= basisUsd;
    state.unreversedInclusionsUsd -= unreversedSold;
  }
  if (Math.abs(state.units - input.unitsYearEnd) > 1e-6 * Math.max(1, Math.abs(input.unitsYearEnd))) {
    throw new Error(`Form 8621: ${input.label} ${input.taxYear} rolls to ${state.units} units, the year end holds ${input.unitsYearEnd}`);
  }
  const basisBeforeMarkUsd = state.adjustedBasisUsd;
  const excess = input.fmvYearEndUsd - basisBeforeMarkUsd;
  let inclusionUsd = 0;
  let deductionUsd = 0;
  let disallowedLossUsd = 0;
  if (state.units > 0 && excess > 0) {
    inclusionUsd = excess;
    state.adjustedBasisUsd += excess;
    state.unreversedInclusionsUsd += excess;
  } else if (state.units > 0 && excess < 0) {
    deductionUsd = Math.min(-excess, state.unreversedInclusionsUsd);
    disallowedLossUsd = -excess - deductionUsd;
    state.adjustedBasisUsd -= deductionUsd;
    state.unreversedInclusionsUsd -= deductionUsd;
  }
  const ordinaryIncomeUsd =
    inclusionUsd - deductionUsd + disposals.reduce((a, d) => a + d.ordinaryGainUsd - d.ordinaryLossUsd, 0);
  return {
    accountId: input.accountId,
    label: input.label,
    taxYear: input.taxYear,
    startBasisUsd,
    startUnits,
    basisBeforeMarkUsd,
    fmvYearEndUsd: input.fmvYearEndUsd,
    inclusionUsd,
    deductionUsd,
    disallowedLossUsd,
    disposals,
    ordinaryIncomeUsd,
    capitalLossUsd: disposals.reduce((a, d) => a + d.capitalLossUsd, 0),
    stateOut: state,
    flags: { partVPossible: input.arrival != null && input.arrival.startUnits > 0, marketableAssumed: true, foreignCorporationAssumed: true },
  };
}

/** Rolls consecutive years of one holding forward (ascending `taxYear`, no gaps required). */
export function form8621RollForward(years: readonly Form8621YearInput[]): Form8621Result[] {
  const out: Form8621Result[] = [];
  let state: Form8621State | null = null;
  for (const y of [...years].sort((a, b) => a.taxYear - b.taxYear)) {
    const r = form8621Year(y, y.arrival ? null : state);
    out.push(r);
    state = r.stateOut;
  }
  return out;
}

function dayBefore(ymd: string): string {
  return addDaysIso(ymd, -1);
}

/**
 * The inputs for `taxYear` of every PFIC holding with a position or a trade in the year, from the
 * ledger. `residencyWindow` is the year's US-person part (it opens on the arrival day in the first
 * year); `opts.firstUsYear` is the year the person became a US person, whose holdings start from
 * {@link Form8621Arrival}. Amounts are converted at their own day's rate through `usdAt`; units are
 * the fund's cuotas or the ETF's shares. Roll the years forward with {@link form8621RollForward}.
 */
export function form8621Inputs(taxYear: number, residencyWindow: DateWindow, usdAt: UsdAt, opts: { firstUsYear: number }): Form8621YearInput[] {
  const ids = (db.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: number }[]).map((r) => r.id).filter((id) => isPficInstrument(id));
  const first = taxYear === opts.firstUsYear;
  const basisDay = first
    ? PFIC_ARRIVAL_BASIS_DAY === "first_day_of_tax_year"
      ? `${taxYear}-01-01`
      : residencyWindow.fromYmd
    : residencyWindow.fromYmd;
  const out: Form8621YearInput[] = [];
  for (const id of ids) {
    const profile = accountProfileOptional(id)!;
    const dates = [dayBefore(residencyWindow.fromYmd), basisDay, residencyWindow.throughYmd];
    const pos = holdingPositionsOn(id, dates)!;
    const [beforeResidency, atBasisDay, atEnd] = pos.positions;
    const tx = holdingTransactionFacts(residencyWindow, id);
    const heldAtStart = (beforeResidency!.cuotas ?? 0) > 0;
    const heldAtEnd = (atEnd!.cuotas ?? 0) > 0;
    if (!heldAtStart && !heldAtEnd && tx.acquisitions.length === 0 && tx.dispositions.length === 0) continue;
    const currency = pos.currency;
    const events: Form8621Event[] = [
      ...tx.acquisitions.map((a): Form8621Event => ({ kind: "acquire", date: a.date, units: a.units, costUsd: usdAt(a.cost, tx.currency ?? currency, a.date) })),
      ...tx.dispositions.map((d): Form8621Event => ({ kind: "dispose", date: d.date, units: d.units, proceedsUsd: usdAt(d.proceeds, tx.currency ?? currency, d.date) })),
    ].sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === "acquire" ? -1 : 1));
    let arrival: Form8621Arrival | null = null;
    if (first && heldAtStart) {
      const startUnits = beforeResidency!.cuotas!;
      // Historic cost of the units held on a day: every purchase at its own day's rate, less the cost of units sold (pro rata, by average cost).
      const all = holdingTransactionFacts({ fromYmd: "0001-01-01", throughYmd: dayBefore(residencyWindow.fromYmd) }, id);
      const cur = all.currency ?? currency;
      const walk = (through: string) => {
        let units = 0;
        let cost = 0;
        const ev = [
          ...all.acquisitions.map((a) => ({ k: "a" as const, date: a.date, id: a.movementId, units: a.units, usd: usdAt(a.cost, cur, a.date) })),
          ...all.dispositions.map((d) => ({ k: "d" as const, date: d.date, id: d.movementId, units: d.units, usd: 0 })),
        ]
          .filter((e) => e.date <= through)
          .sort((a, b) => a.date.localeCompare(b.date) || (a.k === b.k ? a.id - b.id : a.k === "a" ? -1 : 1));
        for (const e of ev) {
          if (e.k === "a") {
            units += e.units;
            cost += e.usd;
          } else {
            const share = units > 0 ? e.units / units : 0;
            cost -= cost * share;
            units -= e.units;
          }
        }
        return { units, cost };
      };
      const atArrival = walk(dayBefore(residencyWindow.fromYmd));
      if (Math.abs(atArrival.units - startUnits) > 1e-6 * Math.max(1, startUnits)) {
        throw new Error(`Form 8621: ${profile.name} cost walk holds ${atArrival.units} units before the residency, the ledger ${startUnits}`);
      }
      // The greater-of rule reaches the units owned on the basis day; units bought after it (before the
      // residency) keep their cost. A sale in between would need a lot split: not modelled.
      const unitsAtBasis = atBasisDay!.cuotas ?? 0;
      if (basisDay < residencyWindow.fromYmd) {
        const between = { fromYmd: addDaysIso(basisDay, 1), throughYmd: dayBefore(residencyWindow.fromYmd) };
        if (all.dispositions.some((d) => d.date >= between.fromYmd && d.date <= between.throughYmd)) {
          throw new Error(`Form 8621: ${profile.name} was sold between the arrival basis day ${basisDay} and the residency — not modelled`);
        }
      }
      const atBasis = basisDay < residencyWindow.fromYmd ? walk(basisDay) : atArrival;
      if (Math.abs(atBasis.units - unitsAtBasis) > 1e-6 * Math.max(1, unitsAtBasis)) {
        throw new Error(`Form 8621: ${profile.name} cost walk holds ${atBasis.units} units on ${basisDay}, the ledger ${unitsAtBasis}`);
      }
      const laterCost = atArrival.cost - atBasis.cost;
      let fmvAtBasis = 0;
      if (unitsAtBasis > 0) {
        if (atBasisDay!.value == null) throw new Error(`Form 8621: ${profile.name} has no value on ${basisDay}`);
        fmvAtBasis = usdAt(atBasisDay!.value, currency, basisDay);
      }
      arrival = { startUnits, startCostBasisUsd: atArrival.cost, startFmvUsd: fmvAtBasis + laterCost };
    }
    if (atEnd!.value == null && heldAtEnd) throw new Error(`Form 8621: ${profile.name} has no value on ${residencyWindow.throughYmd}`);
    out.push({
      accountId: id,
      label: profile.name,
      taxYear,
      arrival,
      events,
      unitsYearEnd: atEnd!.cuotas ?? 0,
      fmvYearEndUsd: heldAtEnd ? usdAt(atEnd!.value!, currency, residencyWindow.throughYmd) : 0,
    });
  }
  return out;
}
