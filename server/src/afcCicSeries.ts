/**
 * AFC Fondo de Cesantía — Cuenta Individual de Cesantía (CIC) valor cuota: `fund_unit_daily`
 * series `afc_cic`, sourced from the Superintendencia de Pensiones' public daily table.
 *
 *   https://www.spensiones.cl/apps/valoresCuotaFondo/vcfAFC.php            (HTML, year + month)
 *   https://www.spensiones.cl/apps/valoresCuotaFondo/vcfAFCxls.php?aaaa=YYYY (CSV, whole year)
 *
 * The CSV is semicolon-separated, Latin-1, Chilean number format (`4.221,76`), one row per
 * CALENDAR day — weekends and holidays print the previous close (flat carries: the fund is
 * valued every day) — with both funds side by side:
 *
 *   ;Fondo de la Cuenta Individual de Cesantia;;Fondo de Cesantia Solidario
 *   Fecha;Valor Cuota;Valor del Patrimonio;Valor Cuota;Valor del Patrimonio
 *   2026-01-02;4.051,04;10811508015009;4.940,42;3506064659931
 *
 * History goes back to 2002 (~15 KB per year), no auth. Day D is available on D+1 and the
 * trailing month is «provisorio, sujeto a confirmación», so the sync re-reads the whole current
 * year on every run and REPLACES a differing stored value (the SP is the authority; a
 * restatement is reported as a sync change, never silently kept). Only the CIC column is
 * stored — the FCS is the solidarity fund, nobody's account.
 */
import { db } from "./db.js";
import { chileCalendarAddDays, type ChileWallClock } from "./chileDate.js";
import { fetchOut } from "./httpOut.js";
import { priorChileBusinessDayYmd } from "./marketHolidays.js";
import type { GlobalSyncStateFile } from "./globalSyncState.js";

export const AFC_CIC_SERIES_KEY = "afc_cic";

/**
 * Chile hour from which the previous business day's valor cuota is expected in DB. The SP
 * publishes day D on D+1 at an hour not documented anywhere; noon is late enough that a
 * morning publication is caught by the wake and early enough that the mark is current by
 * the afternoon. The stale rule and the schedule wake both key on this constant — move it
 * if the sync log shows repeated polls before the row lands.
 */
export const AFC_CIC_PUBLISH_HOUR_CHILE = 12;

const SP_CESANTIA_CSV_BASE = "https://www.spensiones.cl/apps/valoresCuotaFondo/vcfAFCxls.php";
const EXPECTED_HEADER_FUNDS = ["", "Fondo de la Cuenta Individual de Cesantia", "", "Fondo de Cesantia Solidario"];
const EXPECTED_HEADER_COLUMNS = [
  "Fecha",
  "Valor Cuota",
  "Valor del Patrimonio",
  "Valor Cuota",
  "Valor del Patrimonio",
];
const SP_FIRST_YEAR = 2002;

export type SpCesantiaRow = {
  day: string;
  cic_valor_cuota: number;
  cic_patrimonio: number;
  fcs_valor_cuota: number;
  fcs_patrimonio: number;
};

export function spCesantiaCsvUrl(year: number): string {
  if (!Number.isInteger(year) || year < SP_FIRST_YEAR || year > 2200) {
    throw new Error(`afc_cic: invalid year ${year}`);
  }
  return `${SP_CESANTIA_CSV_BASE}?aaaa=${year}`;
}

/** `4.221,76` → 4221.76, `10811508015009` → 10811508015009. Throws on anything else. */
export function parseChileanDecimal(raw: string): number {
  const s = raw.trim();
  if (!/^-?\d{1,3}(\.\d{3})*(,\d+)?$|^-?\d+(,\d+)?$/.test(s)) {
    throw new Error(`afc_cic: unparsable Chilean number «${raw}»`);
  }
  const n = Number(s.replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(n)) throw new Error(`afc_cic: unparsable Chilean number «${raw}»`);
  return n;
}

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Parse one yearly CSV. Fail-fast: the two header lines must match the known layout (a
 * template change must surface, never a silently mis-mapped column), every data row must
 * carry an ISO date and five columns, dates must be strictly ascending, and every valor
 * cuota must be positive.
 */
export function parseSpCesantiaCsv(text: string): SpCesantiaRow[] {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error("afc_cic: CSV has no header lines");
  const funds = lines[0]!.split(";").map((c) => stripAccents(c.trim()));
  if (funds.length !== EXPECTED_HEADER_FUNDS.length || funds.some((c, i) => c !== EXPECTED_HEADER_FUNDS[i])) {
    throw new Error(`afc_cic: unexpected fund header «${lines[0]}»`);
  }
  const cols = lines[1]!.split(";").map((c) => c.trim());
  if (cols.length !== EXPECTED_HEADER_COLUMNS.length || cols.some((c, i) => c !== EXPECTED_HEADER_COLUMNS[i])) {
    throw new Error(`afc_cic: unexpected column header «${lines[1]}»`);
  }
  const rows: SpCesantiaRow[] = [];
  let prevDay = "";
  for (const line of lines.slice(2)) {
    const cells = line.split(";").map((c) => c.trim());
    if (cells.length !== 5) throw new Error(`afc_cic: row with ${cells.length} cells «${line}»`);
    const day = cells[0]!;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`afc_cic: row without ISO date «${line}»`);
    if (day <= prevDay) throw new Error(`afc_cic: dates not ascending at «${line}»`);
    prevDay = day;
    const row: SpCesantiaRow = {
      day,
      cic_valor_cuota: parseChileanDecimal(cells[1]!),
      cic_patrimonio: parseChileanDecimal(cells[2]!),
      fcs_valor_cuota: parseChileanDecimal(cells[3]!),
      fcs_patrimonio: parseChileanDecimal(cells[4]!),
    };
    if (row.cic_valor_cuota <= 0 || row.fcs_valor_cuota <= 0) {
      throw new Error(`afc_cic: non-positive valor cuota at «${line}»`);
    }
    rows.push(row);
  }
  return rows;
}

export async function fetchSpCesantiaYear(
  year: number,
  opts?: { signal?: AbortSignal }
): Promise<SpCesantiaRow[]> {
  const url = spCesantiaCsvUrl(year);
  const res = await fetchOut(`afc_cic:${year}`, url, {
    signal: opts?.signal,
    headers: { "user-agent": "nw-tracker (personal finance tracker; afc_cic sync)" },
  });
  if (!res.ok) throw new Error(`afc_cic: HTTP ${res.status} fetching ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder("latin1").decode(bytes);
  const rows = parseSpCesantiaCsv(text);
  const bad = rows.find((r) => !r.day.startsWith(`${year}-`));
  if (bad) throw new Error(`afc_cic: ${year} CSV carries a row dated ${bad.day}`);
  return rows;
}

export type AfcCicRestatement = { day: string; previous: number; next: number };

export type AfcCicUpsertResult = {
  inserted: number;
  updated: number;
  unchanged: number;
  /** Stored rows whose value the SP now prints differently (provisional → confirmed, or a fix). */
  restated: AfcCicRestatement[];
};

const stmtSelectValue = db.prepare(
  `SELECT unit_value_clp FROM fund_unit_daily WHERE series_key = ? AND day = ?`
);
const stmtUpsert = db.prepare(
  `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note) VALUES (?, ?, ?, ?)
   ON CONFLICT(series_key, day) DO UPDATE SET unit_value_clp = excluded.unit_value_clp, note = excluded.note`
);

/** Upsert the CIC column; the SP value always wins, and a changed stored value is reported. */
export function upsertAfcCicRows(
  rows: readonly SpCesantiaRow[],
  opts: { dryRun: boolean; note: string }
): AfcCicUpsertResult {
  const out: AfcCicUpsertResult = { inserted: 0, updated: 0, unchanged: 0, restated: [] };
  const run = () => {
    for (const r of rows) {
      const px = Math.round(r.cic_valor_cuota * 10000) / 10000;
      const prev = stmtSelectValue.get(AFC_CIC_SERIES_KEY, r.day) as { unit_value_clp: number } | undefined;
      if (prev == null) {
        out.inserted += 1;
      } else if (Math.abs(prev.unit_value_clp - px) > 0.00005) {
        out.updated += 1;
        out.restated.push({ day: r.day, previous: prev.unit_value_clp, next: px });
      } else {
        out.unchanged += 1;
        continue;
      }
      if (!opts.dryRun) stmtUpsert.run(AFC_CIC_SERIES_KEY, r.day, px, opts.note);
    }
  };
  if (opts.dryRun) run();
  else db.transaction(run)();
  return out;
}

const stmtLatestDay = db.prepare(
  `SELECT day, unit_value_clp FROM fund_unit_daily WHERE series_key = ? ORDER BY day DESC LIMIT 1`
);

export function latestAfcCicRow(): { day: string; unit_value_clp: number } | null {
  const r = stmtLatestDay.get(AFC_CIC_SERIES_KEY) as { day: string; unit_value_clp: number } | undefined;
  return r ?? null;
}

const stmtAccountIds = db.prepare(`SELECT id FROM accounts WHERE fund_series_key = ? ORDER BY id`);

/** Accounts declared on the series — the source is disabled when there are none (demo / CI). */
export function afcCicAccountIds(): number[] {
  return (stmtAccountIds.all(AFC_CIC_SERIES_KEY) as { id: number }[]).map((r) => r.id);
}

/**
 * The day whose valor cuota must be in DB at `ymd`: the last Chile business day strictly
 * before it. Weekend and holiday rows are flat carries of that close, so they are never
 * waited for (the mark reads on-or-before) — they land with the next business day's fetch.
 */
export function afcCicExpectedYmd(ymd: string): string {
  const prior = priorChileBusinessDayYmd(ymd);
  if (!prior) throw new Error(`afc_cic: no Chile business day before ${ymd}`);
  return prior;
}

/**
 * Stale = the expected day's row is missing, once it is due: from
 * {@link AFC_CIC_PUBLISH_HOUR_CHILE} when the expected day is yesterday, any hour when it is
 * older (a Sunday waits on Friday's row since Saturday noon). Never stale without an account
 * on the series.
 */
export function isAfcCicStale(
  cl: ChileWallClock,
  _state?: GlobalSyncStateFile,
  opts?: { force?: boolean }
): boolean {
  if (afcCicAccountIds().length === 0) return false;
  if (opts?.force) return true;
  const expected = afcCicExpectedYmd(cl.ymd);
  const latest = latestAfcCicRow()?.day ?? null;
  if (latest != null && latest >= expected) return false;
  const yesterday = chileCalendarAddDays(cl.ymd, -1);
  if (expected === yesterday && cl.hour < AFC_CIC_PUBLISH_HOUR_CHILE) return false;
  return true;
}

/**
 * Pure schedule helper: the first calendar day (from today when the publish hour is still
 * ahead, else tomorrow) whose expected row is beyond `latestDay` — that is when the source
 * next becomes stale. Skips the wakes a naïve "tomorrow noon" would spend on weekend days
 * whose expected row (Friday's) already landed.
 */
export function afcCicNextDueYmd(cl: ChileWallClock, latestDay: string | null): string | null {
  let d = cl.hour < AFC_CIC_PUBLISH_HOUR_CHILE ? cl.ymd : chileCalendarAddDays(cl.ymd, 1);
  for (let i = 0; i < 21; i++) {
    const expected = afcCicExpectedYmd(d);
    if (latestDay == null || expected > latestDay) return d;
    d = chileCalendarAddDays(d, 1);
  }
  return null;
}

export type AfcCicSyncResult = AfcCicUpsertResult & {
  years: number[];
  latest_before: { day: string; unit_value_clp: number } | null;
  latest_after: { day: string; unit_value_clp: number } | null;
};

/**
 * Fetch the current year's CSV (plus the previous year's when its last day is not in DB —
 * January, or a fresh series) and upsert. Full-history backfill is `backfill:afc-cic`.
 */
export async function syncAfcCicFromSp(opts: {
  cl: ChileWallClock;
  dryRun: boolean;
  signal?: AbortSignal;
}): Promise<AfcCicSyncResult> {
  const latest_before = latestAfcCicRow();
  const year = opts.cl.year;
  const years: number[] = [];
  const prevYearEnd = `${year - 1}-12-31`;
  if (year - 1 >= SP_FIRST_YEAR && (latest_before == null || latest_before.day < prevYearEnd)) {
    years.push(year - 1);
  }
  years.push(year);
  const totals: AfcCicUpsertResult = { inserted: 0, updated: 0, unchanged: 0, restated: [] };
  for (const y of years) {
    const rows = await fetchSpCesantiaYear(y, { signal: opts.signal });
    const r = upsertAfcCicRows(rows, { dryRun: opts.dryRun, note: `sp:cesantia-csv|year=${y}` });
    totals.inserted += r.inserted;
    totals.updated += r.updated;
    totals.unchanged += r.unchanged;
    totals.restated.push(...r.restated);
  }
  return { ...totals, years, latest_before, latest_after: opts.dryRun ? latest_before : latestAfcCicRow() };
}
