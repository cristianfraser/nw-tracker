/**
 * The Superintendencia de Pensiones' daily valor cuota of every AFP, one fund (A–E) per file:
 *
 *   https://www.spensiones.cl/apps/valoresCuotaFondo/vcfAFPxls.php?aaaaini=YYYY&aaaafin=YYYY&tf=A&fecconf=YYYYMMDD
 *
 * Semicolon-separated, Latin-1, Chilean numbers (`100.148,38`), one row per CALENDAR day (a
 * weekend or holiday prints the previous value). The file is a run of yearly blocks, each with
 * its own two header lines — the AFP set changes over the years (UNO from 2019-10):
 *
 *   Valores Confirmados
 *
 *   Fecha;CAPITAL;;CUPRUM;;HABITAT;;MODELO;;PLANVITAL;;PROVIDA;;UNO
 *   ;Valor Cuota;Valor Patrimonio;Valor Cuota;Valor Patrimonio;…
 *   2026-10-01;;;99.442,98;9867260780625;…
 *
 * The trailing block is «Valores Provisorios - Sujetos a Confirmacion»; a blank cell is a value
 * the SP has not published yet. The date is the day the fund was valued — an AFP's website
 * shows it later (`afpDisplayFrame.ts`). Stored in `pension_fund_unit_official`; the SP's value
 * always wins and a changed stored value is reported.
 */
import { db } from "./db.js";
import { parseChileanNumber } from "./chileanNumber.js";
import { fetchOut } from "./httpOut.js";

export type PensionFund = "A" | "B" | "C" | "D" | "E";

export type SpAfpFundUnitRow = {
  afp: string;
  fund: PensionFund;
  day: string;
  unit_value_clp: number;
  provisional: boolean;
};

const SP_AFP_CSV_BASE = "https://www.spensiones.cl/apps/valoresCuotaFondo/vcfAFPxls.php";
const SP_FIRST_YEAR = 2002;
const BLOCK_LABELS: Record<string, boolean> = {
  "Valores Confirmados": false,
  "Valores Provisorios - Sujetos a Confirmacion": true,
};

export function spAfpCsvUrl(fund: PensionFund, fromYear: number, toYear: number, confirmedThrough: string): string {
  for (const y of [fromYear, toYear]) {
    if (!Number.isInteger(y) || y < SP_FIRST_YEAR || y > 2200) throw new Error(`sp_afp: invalid year ${y}`);
  }
  if (fromYear > toYear) throw new Error(`sp_afp: ${fromYear} after ${toYear}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(confirmedThrough)) throw new Error(`sp_afp: invalid date ${confirmedThrough}`);
  const fecconf = confirmedThrough.replace(/-/g, "");
  return `${SP_AFP_CSV_BASE}?aaaaini=${fromYear}&aaaafin=${toYear}&tf=${fund}&fecconf=${fecconf}`;
}

/** `PLANVITAL` → `planvital`, `SANTA MARIA` → `santa_maria`. */
export function spAfpSlug(columnName: string): string {
  const s = columnName.trim().toLowerCase().replace(/\s+/g, "_");
  if (!/^[a-z_]+$/.test(s)) throw new Error(`sp_afp: unexpected AFP column name «${columnName}»`);
  return s;
}

/**
 * Parse one fund's file. Fail-fast: every non-data line must be a known block label, a blank,
 * or the two header lines (names, then «Valor Cuota;Valor Patrimonio» per AFP); every data row
 * must carry an ISO date and one cell pair per AFP of its block; dates ascend within a block, and
 * a day a later block reprints must carry the same values.
 */
export function parseSpAfpCsv(text: string, fund: PensionFund): SpAfpFundUnitRow[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).map((l) => l.trimEnd());
  const rows: SpAfpFundUnitRow[] = [];
  let provisional: boolean | null = null;
  let afps: string[] | null = null;
  let expectSubheader = false;
  let prevDay = "";
  let blockStart = false;
  const seen = new Map<string, number>();
  for (const line of lines) {
    if (line.trim() === "") continue;
    if (line in BLOCK_LABELS) {
      provisional = BLOCK_LABELS[line]!;
      afps = null;
      blockStart = true;
      continue;
    }
    if (line.startsWith("Fecha;")) {
      const cells = line.split(";");
      const names: string[] = [];
      for (let i = 1; i < cells.length; i += 2) {
        if (!cells[i]!.trim() || (cells[i + 1] ?? "").trim() !== "") {
          throw new Error(`sp_afp: unexpected AFP header «${line}»`);
        }
        names.push(spAfpSlug(cells[i]!));
      }
      if (cells.length !== 1 + names.length * 2 - 1 && cells.length !== 1 + names.length * 2) {
        throw new Error(`sp_afp: unexpected AFP header «${line}»`);
      }
      afps = names;
      expectSubheader = true;
      continue;
    }
    if (expectSubheader) {
      const expected = ";" + afps!.map(() => "Valor Cuota;Valor Patrimonio").join(";");
      if (line !== expected) throw new Error(`sp_afp: unexpected column header «${line}»`);
      expectSubheader = false;
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2};/.test(line)) throw new Error(`sp_afp: unexpected line «${line}»`);
    if (afps == null || provisional == null) throw new Error(`sp_afp: data before a header «${line}»`);
    const cells = line.split(";");
    if (cells.length !== 1 + afps.length * 2) {
      throw new Error(`sp_afp: row with ${cells.length} cells for ${afps.length} AFPs «${line}»`);
    }
    const day = cells[0]!;
    const blockProvisional = provisional;
    // Dates ascend within a block. A later block may repeat earlier days (the provisional block
    // reprints the current month's confirmed days); a repeated value must be the same.
    if (!blockStart && day <= prevDay) throw new Error(`sp_afp: dates not ascending at «${line}»`);
    blockStart = false;
    prevDay = day;
    afps.forEach((afp, i) => {
      const raw = cells[1 + i * 2]!.trim();
      if (raw === "") return; // not published yet
      const v = parseChileanNumber(raw);
      if (!(v > 0)) throw new Error(`sp_afp: non-positive valor cuota at «${line}»`);
      const prior = seen.get(`${afp}|${day}`);
      if (prior != null) {
        if (Math.abs(prior - v) > 0.005) throw new Error(`sp_afp: ${afp} ${day} printed twice, ${prior} and ${v}`);
        return;
      }
      seen.set(`${afp}|${day}`, v);
      rows.push({ afp, fund, day, unit_value_clp: v, provisional: blockProvisional });
    });
  }
  if (expectSubheader) throw new Error("sp_afp: file ends inside a header");
  return rows;
}

export async function fetchSpAfpFundUnits(
  fund: PensionFund,
  fromYear: number,
  toYear: number,
  confirmedThrough: string,
  opts?: { signal?: AbortSignal }
): Promise<SpAfpFundUnitRow[]> {
  const url = spAfpCsvUrl(fund, fromYear, toYear, confirmedThrough);
  const res = await fetchOut(`sp_afp:${fund}:${fromYear}-${toYear}`, url, {
    signal: opts?.signal,
    headers: { "user-agent": "nw-tracker (personal finance tracker; AFP valor cuota)" },
  });
  if (!res.ok) throw new Error(`sp_afp: HTTP ${res.status} fetching ${url}`);
  const text = new TextDecoder("latin1").decode(new Uint8Array(await res.arrayBuffer()));
  const rows = parseSpAfpCsv(text, fund);
  const bad = rows.find((r) => r.day < `${fromYear}-01-01` || r.day > `${toYear}-12-31`);
  if (bad) throw new Error(`sp_afp: ${fromYear}–${toYear} file carries a row dated ${bad.day}`);
  return rows;
}

export type SpAfpRestatement = { afp: string; fund: PensionFund; day: string; previous: number; next: number };

export type SpAfpUpsertResult = {
  inserted: number;
  updated: number;
  unchanged: number;
  /** Stored values the SP now prints differently (provisional → confirmed, or a fix). */
  restated: SpAfpRestatement[];
};

const stmtSelect = db.prepare(
  `SELECT unit_value_clp, provisional FROM pension_fund_unit_official WHERE afp = ? AND fund = ? AND day = ?`
);
const stmtUpsert = db.prepare(
  `INSERT INTO pension_fund_unit_official (afp, fund, day, unit_value_clp, provisional, fetched_at)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(afp, fund, day) DO UPDATE SET
     unit_value_clp = excluded.unit_value_clp,
     provisional = excluded.provisional,
     fetched_at = excluded.fetched_at`
);

export function upsertSpAfpFundUnits(rows: readonly SpAfpFundUnitRow[], opts: { dryRun: boolean }): SpAfpUpsertResult {
  const out: SpAfpUpsertResult = { inserted: 0, updated: 0, unchanged: 0, restated: [] };
  const now = new Date().toISOString();
  const run = () => {
    for (const r of rows) {
      const prev = stmtSelect.get(r.afp, r.fund, r.day) as { unit_value_clp: number; provisional: number } | undefined;
      if (prev == null) {
        out.inserted += 1;
      } else if (Math.abs(prev.unit_value_clp - r.unit_value_clp) > 0.005 || prev.provisional !== (r.provisional ? 1 : 0)) {
        out.updated += 1;
        if (Math.abs(prev.unit_value_clp - r.unit_value_clp) > 0.005) {
          out.restated.push({ afp: r.afp, fund: r.fund, day: r.day, previous: prev.unit_value_clp, next: r.unit_value_clp });
        }
      } else {
        out.unchanged += 1;
        continue;
      }
      if (!opts.dryRun) stmtUpsert.run(r.afp, r.fund, r.day, r.unit_value_clp, r.provisional ? 1 : 0, now);
    }
  };
  if (opts.dryRun) run();
  else db.transaction(run)();
  return out;
}

/** One AFP's stored official series, ascending. */
export function officialPensionFundUnits(afp: string, fund: PensionFund): { day: string; unit_value_clp: number }[] {
  return db
    .prepare(
      `SELECT day, unit_value_clp FROM pension_fund_unit_official WHERE afp = ? AND fund = ? ORDER BY day`
    )
    .all(afp, fund) as { day: string; unit_value_clp: number }[];
}
