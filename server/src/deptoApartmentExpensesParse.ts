import fs from "node:fs";
import path from "node:path";
import { monthEndDate, numCsv, readSemicolonCsv, type MonthKey } from "../scripts/cfraser-csv.js";

export type DeptoApartmentSlug = "lastarria" | "suecia";

export type DeptoExpenseKind =
  | "gas"
  | "electricidad"
  | "internet"
  | "gastos_comunes"
  | "contribuciones"
  | "kwh";

export type ParsedApartmentExpense = {
  apartment: DeptoApartmentSlug;
  year_month: MonthKey;
  spent_on: string;
  kind: DeptoExpenseKind;
  amount_clp: number;
  category: string;
  note: string;
};

const MONTH_EN: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

/** Column indices in `depto-Table 1-2.csv` (semicolon export; redundant cols removed). */
const COL = {
  YEAR: 0,
  MONTH: 1,
  GAS_CLP: 2,
  GAS_M3: 3,
  ELECTRICIDAD_CLP: 5,
  KWH: 6,
  INTERNET_CLP: 11,
  GASTOS_COMUNES_CLP: 12,
  CONTRIBUCIONES_CLP: 13,
} as const;

const IMPORT_NOTE_PREFIX = "import:depto-gastos|";

function cell(row: string[], i: number): string {
  return (row[i] ?? "").trim();
}

function parseYearCell(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d{4}$/.test(t)) return null;
  const y = Number(t);
  return y >= 2000 && y <= 2100 ? y : null;
}

function parseMonthName(raw: string): number | null {
  let t = raw.trim().toLowerCase();
  t = t.replace(/^->\s*suecia\s*/i, "").replace(/lastarria\s*->\s*/i, "").trim();
  if (!t) return null;
  return MONTH_EN[t] ?? null;
}

function apartmentAndMonthFromRow(
  row: string[],
  currentApartment: DeptoApartmentSlug
): { apartment: DeptoApartmentSlug; monthRaw: string; yearFromCol: number | null } {
  const c0 = cell(row, COL.YEAR);
  const c1 = cell(row, COL.MONTH);
  let apartment = currentApartment;
  if (/suecia/i.test(c0)) apartment = "suecia";
  else if (/lastarria/i.test(c0)) apartment = "lastarria";

  const monthRaw = c1 || c0.replace(/.*->\s*suecia\s*/i, "").replace(/lastarria\s*->\s*/i, "");
  return { apartment, monthRaw, yearFromCol: parseYearCell(c0) };
}

function buildNote(parts: {
  apartment: DeptoApartmentSlug;
  kind: DeptoExpenseKind;
  ym: MonthKey;
  extras?: Record<string, string | number>;
}): string {
  const bits = [`${IMPORT_NOTE_PREFIX}${parts.apartment}|${parts.kind}|${parts.ym}`];
  if (parts.extras) {
    for (const [k, v] of Object.entries(parts.extras)) {
      if (v !== "" && v != null && Number.isFinite(Number(v))) bits.push(`${k}=${v}`);
    }
  }
  return bits.join("|");
}

function pushBill(
  out: ParsedApartmentExpense[],
  opts: {
    apartment: DeptoApartmentSlug;
    ym: MonthKey;
    kind: DeptoExpenseKind;
    amount_clp: number | null;
    extras?: Record<string, string | number>;
  }
): void {
  if (opts.amount_clp == null || !Number.isFinite(opts.amount_clp) || opts.amount_clp < 0) return;
  if (opts.kind !== "kwh" && opts.amount_clp <= 0) return;
  const amount_clp = Math.round(opts.amount_clp);
  out.push({
    apartment: opts.apartment,
    year_month: opts.ym,
    spent_on: monthEndDate(opts.ym),
    kind: opts.kind,
    amount_clp,
    category: opts.kind,
    note: buildNote({ apartment: opts.apartment, kind: opts.kind, ym: opts.ym, extras: opts.extras }),
  });
}

/**
 * Parse `cfraser/depto-Table 1-2.csv` (apartment utility bills).
 * Lastarria: Feb 2023 – May 2024 (gas + kWh). Suecia: Jun 2024 onward (full utilities).
 */
export function parseDeptoTable12ApartmentExpenses(rawRows: string[][]): ParsedApartmentExpense[] {
  const out: ParsedApartmentExpense[] = [];
  let currentYear: number | null = null;
  let apartment: DeptoApartmentSlug = "lastarria";

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i]!;
    if (i < 2) continue;
    if (cell(row, COL.GAS_CLP).toLowerCase() === "gas") continue;
    if (row.every((c) => !String(c ?? "").trim())) continue;

    const { apartment: apt, monthRaw, yearFromCol } = apartmentAndMonthFromRow(row, apartment);
    apartment = apt;
    if (yearFromCol != null) currentYear = yearFromCol;

    const mo = parseMonthName(monthRaw);
    if (mo == null || currentYear == null) continue;

    const ym = `${currentYear}-${String(mo).padStart(2, "0")}` as MonthKey;
    const gasClp = numCsv(cell(row, COL.GAS_CLP));
    const gasM3 = numCsv(cell(row, COL.GAS_M3));
    const kwh = numCsv(cell(row, COL.KWH));

    if (apartment === "lastarria") {
      const extras: Record<string, string | number> = {};
      if (gasM3 != null) extras.m3 = gasM3;
      if (kwh != null && gasClp != null && gasClp > 0) extras.kwh = kwh;
      pushBill(out, { apartment, ym, kind: "gas", amount_clp: gasClp, extras });
      if ((gasClp == null || gasClp <= 0) && kwh != null) {
        pushBill(out, { apartment, ym, kind: "kwh", amount_clp: 0, extras: { kwh } });
      }
      continue;
    }

    const elecExtras: Record<string, string | number> = {};
    if (kwh != null) elecExtras.kwh = kwh;
    pushBill(out, {
      apartment,
      ym,
      kind: "gas",
      amount_clp: gasClp,
      extras: gasM3 != null ? { m3: gasM3 } : undefined,
    });
    pushBill(out, { apartment, ym, kind: "electricidad", amount_clp: numCsv(cell(row, COL.ELECTRICIDAD_CLP)), extras: elecExtras });
    pushBill(out, { apartment, ym, kind: "internet", amount_clp: numCsv(cell(row, COL.INTERNET_CLP)) });
    pushBill(out, {
      apartment,
      ym,
      kind: "gastos_comunes",
      amount_clp: numCsv(cell(row, COL.GASTOS_COMUNES_CLP)),
    });
    pushBill(out, {
      apartment,
      ym,
      kind: "contribuciones",
      amount_clp: numCsv(cell(row, COL.CONTRIBUCIONES_CLP)),
    });
  }

  return out;
}

export function loadDeptoTable12ApartmentExpenses(cfraserDir: string): ParsedApartmentExpense[] {
  const p = path.join(cfraserDir, "depto-Table 1-2.csv");
  if (!fs.existsSync(p)) return [];
  return parseDeptoTable12ApartmentExpenses(readSemicolonCsv(p));
}

export function isDeptoGastosImportNote(note: string | null | undefined): boolean {
  return (note ?? "").startsWith(IMPORT_NOTE_PREFIX);
}
