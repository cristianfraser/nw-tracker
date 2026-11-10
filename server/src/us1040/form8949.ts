/**
 * Form 8949 (Sales and Other Dispositions of Capital Assets): one row per disposal and holding
 * term, from the lot walk's disposals already in dollars (`facts.ts`: proceeds at the sale day,
 * each slice's cost at its purchase day — historic cost, no step-up on becoming a resident,
 * readings §3). Pure.
 *
 * - **Term** by slice (`taxLotTerm`: long-term when held more than one year); a disposal whose slices
 *   straddle the year becomes two rows, the proceeds split by units.
 * - **Box**: a sale through a US broker reports its basis on Form 1099-B → box A (short) / D (long);
 *   a sale through a broker abroad has no 1099-B → C / F. A digital asset (a coin at an exchange
 *   abroad, no Form 1099-DA) is C / F on the 2024 form and the new digital-asset boxes I / L from
 *   2025 («Use box G, H, or I to report short-term digital asset transactions. Do not use box C»,
 *   Instructions for Form 8949 (2025); readings §9).
 * - Amounts round to the dollar per row (d, e), the gain h = d − e. Adjustments (column g) are only
 *   what an extra row brings (an option premium with code E, a later wave); wash sales are NOT
 *   applied to the stocks and ETFs (§1091; stated on the return), and do not reach a coin.
 */
import { taxLotTerm } from "../taxLots.js";

export type Form8949Box = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K" | "L";
export type Form8949Term = "short_term" | "long_term";

/** The first tax year whose Form 8949 has the digital-asset boxes G–L. */
export const FORM_8949_DIGITAL_ASSET_BOXES_FROM_YEAR = 2025;

export type Form8949Row = {
  /** Column (a): «100 sh. XYZ», «0,05 BTC». */
  description: string;
  /** Column (b): the purchase day, or «VARIOUS» for several. */
  acquired: string;
  /** Column (c). */
  sold: string;
  /** Column (d), whole dollars. */
  proceeds: number;
  /** Column (e), whole dollars. */
  cost: number;
  /** Column (f), e.g. «E»; null without an adjustment. */
  adjustmentCode: string | null;
  /** Column (g), whole dollars. */
  adjustment: number;
  /** Column (h) = d − e + g. */
  gain: number;
  term: Form8949Term;
  box: Form8949Box;
  /** Where the row comes from (equity, crypto; an option or other source for an extra row). */
  source: string;
  /** The disposal's movement, for tracing. */
  movementId: number | null;
};

/** One disposal in dollars, before it is split by term. */
export type Form8949Lot = {
  instrument: string;
  /** Unit word for the description («sh.», «BTC»). */
  unitLabel: string;
  sold: string;
  movementId: number;
  units: number;
  proceedsUsd: number;
  slices: readonly { acquiredOn: string; units: number; costUsd: number }[];
  /** The sale went through a US broker that issues a Form 1099-B with basis. */
  reportedOn1099B: boolean;
  digitalAsset: boolean;
  source: string;
};

export function form8949Box(term: Form8949Term, lot: Pick<Form8949Lot, "reportedOn1099B" | "digitalAsset">, taxYear: number): Form8949Box {
  if (lot.digitalAsset && taxYear >= FORM_8949_DIGITAL_ASSET_BOXES_FROM_YEAR) {
    if (lot.reportedOn1099B) throw new Error("Form 8949: a digital asset reported on a 1099-DA is not modelled");
    return term === "short_term" ? "I" : "L";
  }
  if (term === "short_term") return lot.reportedOn1099B ? "A" : "C";
  return lot.reportedOn1099B ? "D" : "F";
}

function fmtUnits(units: number): string {
  return String(Math.round(units * 1e8) / 1e8);
}

/** The rows of the lots, in the lots' order, short before long within a lot. */
export function form8949Rows(lots: readonly Form8949Lot[], taxYear: number): Form8949Row[] {
  const out: Form8949Row[] = [];
  for (const lot of lots) {
    if (!(lot.units > 0)) throw new Error(`Form 8949: disposal ${lot.movementId} of ${lot.units} units`);
    const sliceUnits = lot.slices.reduce((s, x) => s + x.units, 0);
    if (Math.abs(sliceUnits - lot.units) > 1e-6 * Math.max(1, lot.units)) {
      throw new Error(`Form 8949: disposal ${lot.movementId}: slices hold ${sliceUnits} units, the sale ${lot.units}`);
    }
    for (const term of ["short_term", "long_term"] as const) {
      const slices = lot.slices.filter((s) => taxLotTerm(s.acquiredOn, lot.sold, "long") === term);
      if (slices.length === 0) continue;
      const units = slices.reduce((s, x) => s + x.units, 0);
      const proceeds = Math.round(lot.proceedsUsd * (units / lot.units));
      const cost = Math.round(slices.reduce((s, x) => s + x.costUsd, 0));
      const dates = [...new Set(slices.map((s) => s.acquiredOn))];
      out.push({
        description: `${fmtUnits(units)} ${lot.unitLabel} ${lot.instrument}`,
        acquired: dates.length === 1 ? dates[0]! : "VARIOUS",
        sold: lot.sold,
        proceeds,
        cost,
        adjustmentCode: null,
        adjustment: 0,
        gain: proceeds - cost,
        term,
        box: form8949Box(term, lot, taxYear),
        source: lot.source,
        movementId: lot.movementId,
      });
    }
  }
  return out;
}

/** Throws unless an extra row (a later wave's option or PFIC rows) is whole dollars and adds up. */
export function assertForm8949Row(r: Form8949Row): void {
  for (const k of ["proceeds", "cost", "adjustment", "gain"] as const) {
    if (!Number.isInteger(r[k])) throw new Error(`Form 8949: ${r.description}: column ${k} = ${r[k]} is not whole dollars`);
  }
  if (r.gain !== r.proceeds - r.cost + r.adjustment) {
    throw new Error(`Form 8949: ${r.description}: h = ${r.gain}, d − e + g = ${r.proceeds - r.cost + r.adjustment}`);
  }
}
