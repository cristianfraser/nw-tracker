/**
 * A declared tax residency: where the person is a tax resident from a given day, declared by the
 * user (`POST /api/tax-residency`, the Settings panel) or by the demo generator, never inferred
 * from pay stubs, days abroad or accounts (`tax_residency_periods`, migration 302). One open period
 * at a time; declaring a new one closes the previous the day before. With nothing declared the
 * person is a Chilean tax resident, as the app always assumed.
 *
 * What the law says, read 2026-11-10 (the consolidated texts at bcn.cl, obtxml; the SII's own
 * documents where named):
 *
 * - **LIR (DL 824) art. 3:** «toda persona domiciliada o residente en Chile, pagará impuesto sobre
 *   sus rentas de cualquier origen … y las personas no residentes en Chile estarán sujetas a
 *   impuestos sobre sus rentas cuya fuente esté dentro del país». Art. 10: «Se considerarán rentas
 *   de fuente chilena, las que provengan de bienes situados en el país o de actividades
 *   desarrolladas en él cualquiera que sea el domicilio o residencia del contribuyente». Art. 11:
 *   shares of a Chilean S.A. are located in Chile; the interest of a credit at the debtor's
 *   domicile; fund cuotas «se regirán por lo establecido en la ley N° 20.712».
 * - **LIR art. 4:** «la ausencia o falta de residencia en el país no es causal que determine la
 *   pérdida de domicilio en Chile si la persona conserva, en forma directa o indirecta, el asiento
 *   principal de sus negocios en Chile». The SII (Oficio N° 2306 de 19.08.2016, citing Oficio 1383
 *   de 2015) reads the asiento principal as «el lugar donde la persona ejerce la actividad de la
 *   cual obtiene la mayor parte de sus ingresos y donde se encuentran radicados sus principales
 *   intereses», and concludes that a person who no longer is a resident «y tampoco conserva en
 *   Chile el asiento principal de sus negocios, ha perdido su domicilio en Chile». Whether two
 *   rented apartments and a mortgage are such a seat is the SII's call on the facts — which is why
 *   the residency is DECLARED here and the return says so (`F22_RESIDENCY_ASSUMPTION`).
 * - **Código Tributario (DL 830) art. 8 N° 8:** «Por "residente", toda persona que permanezca en
 *   Chile, en forma ininterrumpida o no, por un período o períodos que en total excedan de 183 días,
 *   dentro de un lapso cualquiera de doce meses» (the bcn.cl text does not name Ley 21.210 as the
 *   source of the 183-day wording; Oficio 2306/2016 still quoted the earlier six-month rule).
 * - **LIR art. 103:** «Los contribuyentes que dejaren de estar afectos al impuesto Global
 *   Complementario en razón de que perderán su domicilio y residencia deberán declarar y pagar la
 *   parte del impuesto devengado correspondiente al año calendario de que se trate antes de
 *   ausentarse del país. En tal caso, los créditos contra el impuesto, contemplados en los números
 *   1° y 2° del artículo 56° se concederán en forma proporcional al período a que corresponden las
 *   rentas declaradas. Asimismo, se aplicarán proporcionalmente las unidades tributarias referidas
 *   en los artículos 52° y 57°.» That departure return (prorated brackets) is NOT built; the F22 of
 *   the departure year is drafted as two parts (`f22/draft.ts`) and says so.
 * - **Chile–US convention** (sii.cl `chile_usa_ing.pdf`), art. 4(1)–(2): a dual resident is a
 *   resident only of the State of his permanent home, else the centre of vital interests, habitual
 *   abode, nationality, mutual agreement. The declared date is the user's reading of that test.
 *
 * Readers: {@link taxResidencyOn} (one day) and {@link residencyForIncomeYear} (a calendar year:
 * `cl: "full" | "none" | {through}`, `us: "full" | "none" | {from}`). A year with two changes, or a
 * return to Chile mid-year, is not modelled and throws.
 */
import { addDaysIso, isIsoDate } from "nw-tracker-contracts";
import { db } from "./db.js";

export const TAX_JURISDICTIONS = ["cl", "us"] as const;
export type TaxJurisdiction = (typeof TAX_JURISDICTIONS)[number];

export type TaxResidencyPeriod = {
  id: number;
  jurisdiction: TaxJurisdiction;
  fromDate: string;
  /** Null: the open period. */
  toDate: string | null;
  note: string | null;
  createdAt: string;
};

/** The assumption every return built on a declared residency states (i18n key on the client: `taxReturn.residency.assumption`). */
export const F22_RESIDENCY_ASSUMPTION =
  "Declared, not inferred. Chile may hold that domicile continued while the main seat of business stayed in Chile (LIR art. 4); this return assumes the declared date.";

export class TaxResidencyInputError extends Error {}

type Row = { id: number; jurisdiction: string; from_date: string; to_date: string | null; note: string | null; created_at: string };

function fromRow(r: Row): TaxResidencyPeriod {
  if (!TAX_JURISDICTIONS.includes(r.jurisdiction as TaxJurisdiction)) {
    throw new Error(`tax_residency_periods ${r.id}: unknown jurisdiction ${r.jurisdiction}`);
  }
  return {
    id: r.id,
    jurisdiction: r.jurisdiction as TaxJurisdiction,
    fromDate: r.from_date,
    toDate: r.to_date,
    note: r.note,
    createdAt: r.created_at,
  };
}

/** Every declared period, oldest first. */
export function listTaxResidencyPeriods(): TaxResidencyPeriod[] {
  const rows = db
    .prepare(`SELECT id, jurisdiction, from_date, to_date, note, created_at FROM tax_residency_periods ORDER BY from_date, id`)
    .all() as Row[];
  return rows.map(fromRow);
}

export type TaxResidencyOnDay = {
  jurisdiction: TaxJurisdiction;
  /** The period covering the day; null when none does (Chile, undeclared). */
  period: TaxResidencyPeriod | null;
  declared: boolean;
};

/** Where the person is a tax resident on `ymd`: the declared period covering it, else Chile (undeclared). */
export function taxResidencyOn(ymd: string, periods: readonly TaxResidencyPeriod[] = listTaxResidencyPeriods()): TaxResidencyOnDay {
  if (!isIsoDate(ymd)) throw new Error(`taxResidencyOn: not an ISO day: ${ymd}`);
  const period = periods.find((p) => p.fromDate <= ymd && (p.toDate == null || ymd <= p.toDate)) ?? null;
  return period ? { jurisdiction: period.jurisdiction, period, declared: true } : { jurisdiction: "cl", period: null, declared: false };
}

export type YearResidencySide<Partial extends { through: string } | { from: string }> = "full" | "none" | Partial;

export type YearResidency = {
  incomeYear: number;
  /** Chile: the whole year, none of it, or through the declared departure day. */
  cl: YearResidencySide<{ through: string }>;
  /** The US: the whole year, none of it, or from the day after the departure. */
  us: YearResidencySide<{ from: string }>;
  /** Whether a declared period covers any day of the year (false: the undeclared default, Chile). */
  declared: boolean;
  /** The periods covering the year, oldest first (empty when undeclared). */
  periods: TaxResidencyPeriod[];
};

/**
 * The residency of an income year from the declared periods. Days before the first declared period
 * are Chile (undeclared). At most one change inside the year, Chile → US, is modelled: the departure
 * year; a return to Chile, or two changes, throws.
 */
export function residencyForIncomeYear(incomeYear: number, periods: readonly TaxResidencyPeriod[] = listTaxResidencyPeriods()): YearResidency {
  const first = `${incomeYear}-01-01`;
  const last = `${incomeYear}-12-31`;
  const covering = periods.filter((p) => p.fromDate <= last && (p.toDate == null || p.toDate >= first));
  if (covering.length === 0) return { incomeYear, cl: "full", us: "none", declared: false, periods: [] };
  // Segments of the year by jurisdiction: an undeclared gap at the start reads as Chile.
  const segments: { jurisdiction: TaxJurisdiction; from: string; through: string }[] = [];
  let cursor = first;
  for (const p of covering) {
    if (p.fromDate > cursor) segments.push({ jurisdiction: "cl", from: cursor, through: addDaysIso(p.fromDate, -1) });
    const through = p.toDate == null || p.toDate > last ? last : p.toDate;
    segments.push({ jurisdiction: p.jurisdiction, from: p.fromDate < cursor ? cursor : p.fromDate, through });
    cursor = addDaysIso(through, 1);
  }
  if (cursor <= last) segments.push({ jurisdiction: "cl", from: cursor, through: last });
  // Merge adjacent segments of one jurisdiction (an undeclared gap followed by a declared Chile period).
  const merged: typeof segments = [];
  for (const s of segments) {
    const prev = merged[merged.length - 1];
    if (prev && prev.jurisdiction === s.jurisdiction) prev.through = s.through;
    else merged.push({ ...s });
  }
  if (merged.length === 1) {
    const only = merged[0]!;
    return {
      incomeYear,
      cl: only.jurisdiction === "cl" ? "full" : "none",
      us: only.jurisdiction === "us" ? "full" : "none",
      declared: true,
      periods: covering,
    };
  }
  if (merged.length === 2 && merged[0]!.jurisdiction === "cl" && merged[1]!.jurisdiction === "us") {
    return {
      incomeYear,
      cl: { through: merged[0]!.through },
      us: { from: merged[1]!.from },
      declared: true,
      periods: covering,
    };
  }
  throw new Error(
    `tax residency ${incomeYear}: ${merged.map((s) => `${s.jurisdiction} ${s.from}→${s.through}`).join(", ")} — only a departure from Chile to the US within a year is modelled`
  );
}

export type DeclareTaxResidencyInput = { jurisdiction: string; fromDate: string; note?: string | null };

/**
 * Declare a residency from a day: the new period must start after every declared one (declarations
 * are chronological; delete the latest to correct it), and it closes the open period the day before.
 * Declaring the jurisdiction the open period already names is refused (nothing would change).
 */
export function declareTaxResidency(input: DeclareTaxResidencyInput): TaxResidencyPeriod {
  if (!TAX_JURISDICTIONS.includes(input.jurisdiction as TaxJurisdiction)) {
    throw new TaxResidencyInputError(`jurisdiction must be one of ${TAX_JURISDICTIONS.join(", ")}`);
  }
  if (typeof input.fromDate !== "string" || !isIsoDate(input.fromDate)) throw new TaxResidencyInputError("from_date must be YYYY-MM-DD");
  const note = input.note == null || input.note.trim() === "" ? null : input.note.trim();
  if (note != null && note.length > 500) throw new TaxResidencyInputError("note: at most 500 characters");
  return db.transaction(() => {
    const periods = listTaxResidencyPeriods();
    const latest = periods[periods.length - 1];
    if (latest) {
      if (input.fromDate <= latest.fromDate) {
        throw new TaxResidencyInputError(`from_date must be after the latest declared period (${latest.fromDate}); delete it first to correct it`);
      }
      if (latest.toDate != null && input.fromDate <= latest.toDate) {
        throw new TaxResidencyInputError(`from_date overlaps the period ending ${latest.toDate}`);
      }
      if (latest.toDate == null) {
        if (latest.jurisdiction === input.jurisdiction) {
          throw new TaxResidencyInputError(`already a ${input.jurisdiction} tax resident from ${latest.fromDate}`);
        }
        db.prepare(`UPDATE tax_residency_periods SET to_date = ? WHERE id = ?`).run(addDaysIso(input.fromDate, -1), latest.id);
      }
    }
    const id = Number(
      db
        .prepare(`INSERT INTO tax_residency_periods (jurisdiction, from_date, to_date, note) VALUES (?, ?, NULL, ?)`)
        .run(input.jurisdiction, input.fromDate, note).lastInsertRowid
    );
    const row = db.prepare(`SELECT id, jurisdiction, from_date, to_date, note, created_at FROM tax_residency_periods WHERE id = ?`).get(id) as Row;
    return fromRow(row);
  })();
}

/** Delete the latest declared period, reopening the one before it; false when `id` is not the latest. */
export function deleteTaxResidencyPeriod(id: number): boolean {
  return db.transaction(() => {
    const periods = listTaxResidencyPeriods();
    const latest = periods[periods.length - 1];
    if (!latest || latest.id !== id) return false;
    const previous = periods[periods.length - 2];
    db.prepare(`DELETE FROM tax_residency_periods WHERE id = ?`).run(id);
    if (previous) db.prepare(`UPDATE tax_residency_periods SET to_date = NULL WHERE id = ?`).run(previous.id);
    return true;
  })();
}
