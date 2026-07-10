import { assertValuationCurrencyClp } from "./valuationValue.js";
import { accountKindSlugForAccountId } from "./accountBucket.js";
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  AFP_UNO_CUOTA_SERIES_KEY,
  extractFundUnitRowsFromQuetalmiJson,
  fetchQuetalmiCuotas,
  toDdMmYyyy,
} from "./afpQuetalmiApi.js";
import { countFundUnitRowsInRange, upsertFundUnitSpotPreservingHistory } from "./fundUnitDaily.js";
import { portfolioStartYmd } from "./portfolioStart.js";
import { transferLegUnitsThroughDate } from "./movementTransfer.js";

/** SQL fragment: import rows that affect AFP Uno cuotas (sheet deposits + fixed 10% retiros + cert sync tags + Modelo prior adjustment). */
export const AFP_IMPORT_CUOTAS_NOTE_SQL = `(note LIKE '%Table1-3|AFP%' OR note LIKE 'import:excel|retiro-10pct|UNO-Fondo-A|%' OR note LIKE '%|afp-cert:period=%' OR note LIKE 'import:excel|afp-modelo-prior-cuotas%' OR note LIKE 'import:excel|afp-orphan-cert-month%' OR note LIKE 'import:excel|afp-antecedentes-opening%' OR note LIKE 'import:excel|afp-cuotas-synthetic-trim%' OR note LIKE 'import:excel|afp-cuotas-website-reconcile%')`;

/**
 * Cumulative AFP cuotas: Σ `movements.units_delta` on the account plus manual transfer legs.
 * The cuota ledger is cert-backed and reconciled (Σ equals the official AFP website total,
 * including the one small historical reconcile correction, itself a movement). A wrong sum
 * is data to fix in the ledger — no target snapping or note-filtered fallbacks.
 */
export function afpCuotasCumulativeThroughDate(accountId: number, asOfYmd: string): number {
  const manual = transferLegUnitsThroughDate(accountId, asOfYmd);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(units_delta, 0)), 0) AS u
       FROM movements
       WHERE account_id = ? AND date(occurred_on) <= date(?)`
    )
    .get(accountId, asOfYmd) as { u: number };
  return Math.round(((row?.u ?? 0) + manual) * 10000) / 10000;
}

export function latestFundUnitRowOnOrBefore(
  seriesKey: string,
  asOfYmd: string
): { day: string; unit_value_clp: number } | null {
  const r = db
    .prepare(
      `SELECT day, unit_value_clp FROM fund_unit_daily
       WHERE series_key = ? AND day <= ?
       ORDER BY day DESC LIMIT 1`
    )
    .get(seriesKey, asOfYmd) as { day: string; unit_value_clp: number } | undefined;
  const v = r?.unit_value_clp;
  if (v == null || !Number.isFinite(v) || v <= 0 || !r?.day) return null;
  return { day: r.day, unit_value_clp: v };
}

const AFP_CERT_FUND_UNIT_SCRATCH = "afp-cert:monto/cuotas_delta";

/**
 * Prefer a **quoted** valor-cuota (Quetalmi, uno.cl, CSV, etc.) over certificate scratch rows
 * (`monto/cuotas` per movement line can be wrong for display).
 */
export function latestAfpUnoFundUnitRowOnOrBeforeForDisplay(
  seriesKey: string,
  asOfYmd: string
): { day: string; unit_value_clp: number } | null {
  const rows = db
    .prepare(
      `SELECT day, unit_value_clp, COALESCE(note, '') AS note FROM fund_unit_daily
       WHERE series_key = ? AND day <= ?
       ORDER BY day DESC
       LIMIT 60`
    )
    .all(seriesKey, asOfYmd) as { day: string; unit_value_clp: number; note: string }[];
  for (const r of rows) {
    if (!r.note.includes(AFP_CERT_FUND_UNIT_SCRATCH)) {
      const v = r.unit_value_clp;
      if (v != null && Number.isFinite(v) && v > 0 && r.day) {
        return { day: r.day, unit_value_clp: v };
      }
    }
  }
  return latestFundUnitRowOnOrBefore(seriesKey, asOfYmd);
}

/** Prior reputable valor cuota strictly before `beforeDay` (skips cert scratch rows). */
export function priorAfpUnoFundUnitRowBeforeForDisplay(
  seriesKey: string,
  beforeDay: string
): { day: string; unit_value_clp: number } | null {
  const rows = db
    .prepare(
      `SELECT day, unit_value_clp, COALESCE(note, '') AS note FROM fund_unit_daily
       WHERE series_key = ? AND day < ?
       ORDER BY day DESC
       LIMIT 60`
    )
    .all(seriesKey, beforeDay) as { day: string; unit_value_clp: number; note: string }[];
  for (const r of rows) {
    if (!r.note.includes(AFP_CERT_FUND_UNIT_SCRATCH)) {
      const v = r.unit_value_clp;
      if (v != null && Number.isFinite(v) && v > 0 && r.day) {
        return { day: r.day, unit_value_clp: v };
      }
    }
  }
  return null;
}

/** Upsert latest UNO Fondo A valor cuota from the public homepage (authoritative spot). */
export async function refreshAfpUnoFundUnitFromUnoWebsite(opts?: {
  signal?: AbortSignal;
}): Promise<{ day: string; unit_value_clp: number } | null> {
  const { fetchUnoClFondoAValorCuota } = await import("./afpUnoWebsiteCuota.js");
  const r = await fetchUnoClFondoAValorCuota(opts);
  const day = (r.quote_day_ymd && /^\d{4}-\d{2}-\d{2}$/.test(r.quote_day_ymd) ? r.quote_day_ymd : null) ?? chileCalendarTodayYmd();
  const vRounded = Math.round(r.unit_value_clp * 100) / 100;
  db.prepare(
    `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note) VALUES (?,?,?,?)
     ON CONFLICT(series_key, day) DO UPDATE SET unit_value_clp = excluded.unit_value_clp, note = excluded.note`
  ).run(AFP_UNO_CUOTA_SERIES_KEY, day, vRounded, "uno.cl:homepage:fondo-a");
  return { day, unit_value_clp: vRounded };
}

export function latestFundUnitClpOnOrBefore(seriesKey: string, asOfYmd: string): number | null {
  return latestFundUnitRowOnOrBefore(seriesKey, asOfYmd)?.unit_value_clp ?? null;
}

export function revalueAfpAccountFromCuotas(opts: {
  accountId: number;
  seriesKey?: string;
  dryRun: boolean;
  /**
   * When true, only refresh `units_snapshot` from Σ cuotas; keep existing `value_clp` (e.g. Table 1-3 / Excel import).
   * Use when `fund_unit_daily` is for reference or you want sheet month-ends as SoT.
   */
  preserveExcelValues?: boolean;
}): { updated: number; skipped: number; lines: string[] } {
  const seriesKey = opts.seriesKey ?? AFP_UNO_CUOTA_SERIES_KEY;
  const lines: string[] = [];
  let updated = 0;
  let skipped = 0;

  const kind = accountKindSlugForAccountId(opts.accountId);
  if (kind !== "afp") {
    throw new Error(`Account ${opts.accountId} is not category "afp" (got ${kind ?? "missing"})`);
  }

  const vals = db
    .prepare(
      `SELECT as_of_date, value AS value_clp, currency, units_snapshot FROM valuations
       WHERE account_id = ? ORDER BY as_of_date ASC`
    )
    .all(opts.accountId) as { as_of_date: string; value_clp: number; currency: string; units_snapshot: number | null }[];
  for (const v of vals) assertValuationCurrencyClp(v.currency, "afpUnoValuation rebuild");

  const upsert = db.prepare(`
    INSERT INTO valuations (account_id, as_of_date, value, currency, units_snapshot)
    VALUES (@account_id, @as_of_date, @value_clp, 'clp', @units_snapshot)
    ON CONFLICT(account_id, as_of_date) DO UPDATE SET
      value = excluded.value,
      currency = excluded.currency,
      units_snapshot = excluded.units_snapshot
  `);

  const preserve = opts.preserveExcelValues === true;

  for (const v of vals) {
    const units = afpCuotasCumulativeThroughDate(opts.accountId, v.as_of_date);
    if (preserve) {
      lines.push(`${v.as_of_date}\tunits=${units.toFixed(4)}\tpreserve-value\tvalue_clp=${v.value_clp}`);
      if (!opts.dryRun) {
        upsert.run({
          account_id: opts.accountId,
          as_of_date: v.as_of_date,
          value_clp: v.value_clp,
          units_snapshot: units,
        });
      }
      updated += 1;
      continue;
    }

    const px = latestFundUnitClpOnOrBefore(seriesKey, v.as_of_date);
    if (px == null || units <= 0) {
      lines.push(`${v.as_of_date}\tunits=${units.toFixed(4)}\tpx=—\tskip`);
      skipped += 1;
      continue;
    }
    const value_clp = Math.round(units * px * 100) / 100;
    lines.push(
      `${v.as_of_date}\tunits=${units.toFixed(4)}\tpx=${px.toFixed(2)}\tvalue=${value_clp}\tprev=${v.value_clp}`
    );
    if (!opts.dryRun) {
      upsert.run({
        account_id: opts.accountId,
        as_of_date: v.as_of_date,
        value_clp,
        units_snapshot: units,
      });
    }
    updated += 1;
  }

  return { updated, skipped, lines };
}

/** Mark-to-market AFP on Chile “today” (or `asOfYmd`) using latest valor cuota on or before that date. */
export function upsertAfpSpotValuation(opts: {
  accountId: number;
  asOfYmd?: string;
  seriesKey?: string;
  dryRun: boolean;
}): { as_of_date: string; value_clp: number; units: number; px: number } | null {
  const seriesKey = opts.seriesKey ?? AFP_UNO_CUOTA_SERIES_KEY;
  const asOf = opts.asOfYmd ?? chileCalendarTodayYmd();
  const px = latestFundUnitClpOnOrBefore(seriesKey, asOf);
  const units = afpCuotasCumulativeThroughDate(opts.accountId, asOf);
  if (px == null || units <= 0) return null;
  const value_clp = Math.round(units * px * 100) / 100;
  if (!opts.dryRun) {
    db.prepare(
      `INSERT INTO valuations (account_id, as_of_date, value, currency, units_snapshot)
       VALUES (?, ?, ?, 'clp', ?)
       ON CONFLICT(account_id, as_of_date) DO UPDATE SET
         value = excluded.value,
         currency = excluded.currency,
         units_snapshot = excluded.units_snapshot`
    ).run(opts.accountId, asOf, value_clp, units);
  }
  return { as_of_date: asOf, value_clp, units, px };
}

/** One `fund_unit_daily` row (e.g. spot from [uno.cl](https://www.uno.cl/))); preserves daily history. */
export function upsertFundUnitDailyRow(opts: {
  seriesKey?: string;
  day: string;
  unit_value_clp: number;
  note: string;
  dryRun: boolean;
}): { gapDaysFilled: number } {
  return upsertFundUnitSpotPreservingHistory({
    seriesKey: opts.seriesKey ?? AFP_UNO_CUOTA_SERIES_KEY,
    observationDay: opts.day,
    unitValueClp: opts.unit_value_clp,
    note: opts.note,
    carryNote: "afp:carry-forward",
    dryRun: opts.dryRun,
  });
}

/**
 * Spot valuation using an explicit valor cuota (e.g. same-day [uno.cl](https://www.uno.cl/) when DB series lags).
 */
export function upsertAfpSpotValuationWithExplicitPx(opts: {
  accountId: number;
  asOfYmd?: string;
  px: number;
  dryRun: boolean;
}): { as_of_date: string; value_clp: number; units: number; px: number } | null {
  const asOf = opts.asOfYmd ?? chileCalendarTodayYmd();
  const px = opts.px;
  if (!Number.isFinite(px) || px <= 0) return null;
  const units = afpCuotasCumulativeThroughDate(opts.accountId, asOf);
  if (units <= 0) return null;
  const value_clp = Math.round(units * px * 100) / 100;
  if (!opts.dryRun) {
    db.prepare(
      `INSERT INTO valuations (account_id, as_of_date, value, currency, units_snapshot)
       VALUES (?, ?, ?, 'clp', ?)
       ON CONFLICT(account_id, as_of_date) DO UPDATE SET
         value = excluded.value,
         currency = excluded.currency,
         units_snapshot = excluded.units_snapshot`
    ).run(opts.accountId, asOf, value_clp, units);
  }
  return { as_of_date: asOf, value_clp, units, px };
}

export async function upsertFundUnitsFromQuetalmiFetch(opts: {
  apiKey: string;
  fechaInicialDdMmYyyy: string;
  fechaFinalDdMmYyyy: string;
  dryRun: boolean;
  /**
   * When true, an empty parse (no daily rows in range) returns `{ rows: 0 }` instead of throwing.
   * Use for chunked historical backfill where some windows predate AFP UNO Fondo A coverage.
   */
  allowEmpty?: boolean;
}): Promise<{ rows: number }> {
  const raw = await fetchQuetalmiCuotas({
    apiKey: opts.apiKey,
    listaAFPs: "UNO",
    listaFondos: "A",
    fechaInicialDdMmYyyy: opts.fechaInicialDdMmYyyy,
    fechaFinalDdMmYyyy: opts.fechaFinalDdMmYyyy,
  });
  const extracted = extractFundUnitRowsFromQuetalmiJson(raw);
  if (extracted.length === 0) {
    if (opts.allowEmpty) return { rows: 0 };
    const keys = raw != null && typeof raw === "object" ? Object.keys(raw as object).join(",") : typeof raw;
    throw new Error(
      `Could not parse any fund-unit rows from API response (top-level keys: ${keys}). ` +
        `Inspect JSON shape and extend extractFundUnitRowsFromQuetalmiJson in afpQuetalmiApi.ts`
    );
  }
  const ins = db.prepare(
    `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note) VALUES (?,?,?,?)
     ON CONFLICT(series_key, day) DO UPDATE SET unit_value_clp = excluded.unit_value_clp, note = excluded.note`
  );
  let n = 0;
  for (const r of extracted) {
    if (opts.dryRun) {
      n += 1;
      continue;
    }
    ins.run(AFP_UNO_CUOTA_SERIES_KEY, r.day, r.unit_value_clp, r.note ?? "quetalmiafp");
    n += 1;
  }
  return { rows: n };
}

function ymdAddDays(ymd: string, deltaDays: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) throw new Error(`Invalid YYYY-MM-DD: ${ymd}`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + deltaDays, 12, 0, 0, 0);
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function ymdMin(a: string, b: string): string {
  return a <= b ? a : b;
}

/**
 * Chunked Quetalmi fetch into `fund_unit_daily` (`afp_uno_cuota_a`) for market “rates” / charts.
 * Windows with no parsed rows are skipped when `allowEmpty` is used per chunk (API may have no UNO Fondo A data yet).
 */
export async function backfillAfpUnoCuotaQuetalmiChunks(opts: {
  apiKey: string;
  fromYmd: string;
  toYmd: string;
  chunkDays?: number;
  dryRun: boolean;
  /** Pause between HTTP calls (rate courtesy). Default 250ms. */
  delayMs?: number;
  /** Optional log line per chunk: `(chunkStart, chunkEnd, rows)` */
  onChunk?: (startYmd: string, endYmd: string, rows: number) => void;
}): Promise<{ totalRows: number; chunks: number; emptyChunks: number }> {
  const chunkDays = Math.max(1, Math.floor(opts.chunkDays ?? 180));
  const delayMs = opts.delayMs ?? 250;
  let totalRows = 0;
  let chunks = 0;
  let emptyChunks = 0;
  let cur = opts.fromYmd.trim();
  const to = opts.toYmd.trim();
  if (cur > to) {
    throw new Error(`fromYmd (${cur}) must be <= toYmd (${to})`);
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  while (cur <= to) {
    const chunkEnd = ymdMin(ymdAddDays(cur, chunkDays - 1), to);
    const fi = toDdMmYyyy(cur);
    const ff = toDdMmYyyy(chunkEnd);
    if (!fi || !ff) throw new Error(`Invalid range ${cur} … ${chunkEnd}`);
    const { rows } = await upsertFundUnitsFromQuetalmiFetch({
      apiKey: opts.apiKey,
      fechaInicialDdMmYyyy: fi,
      fechaFinalDdMmYyyy: ff,
      dryRun: opts.dryRun,
      allowEmpty: true,
    });
    chunks += 1;
    totalRows += rows;
    if (rows === 0) emptyChunks += 1;
    opts.onChunk?.(cur, chunkEnd, rows);
    cur = ymdAddDays(chunkEnd, 1);
    if (cur <= to && delayMs > 0) await sleep(delayMs);
  }
  return { totalRows, chunks, emptyChunks };
}

const AFP_QUETALMI_MIN_ROWS_RECENT = 45;
const AFP_QUETALMI_RECENT_DAYS = 365;

/** Backfill recent AFP history from Quetalmi when `fund_unit_daily` is almost empty. */
export async function ensureAfpUnoQuetalmiRecentHistory(opts: {
  apiKey: string;
  dryRun: boolean;
}): Promise<{ ran: boolean; totalRows: number }> {
  const today = chileCalendarTodayYmd();
  const from = portfolioStartYmd();
  const recentFrom =
    from > ymdAddDays(today, -AFP_QUETALMI_RECENT_DAYS) ? from : ymdAddDays(today, -AFP_QUETALMI_RECENT_DAYS);
  const count = countFundUnitRowsInRange(AFP_UNO_CUOTA_SERIES_KEY, recentFrom, today);
  if (count >= AFP_QUETALMI_MIN_ROWS_RECENT) {
    return { ran: false, totalRows: 0 };
  }
  console.log(
    `sync: AFP UNO — Quetalmi backfill (${count} rows in last ${AFP_QUETALMI_RECENT_DAYS}d, fetching ${recentFrom}…${today})`
  );
  const { totalRows } = await backfillAfpUnoCuotaQuetalmiChunks({
    apiKey: opts.apiKey,
    fromYmd: recentFrom,
    toYmd: today,
    chunkDays: 120,
    dryRun: opts.dryRun,
    onChunk: (a, b, rows) => {
      if (rows > 0) console.log(`sync: AFP UNO — Quetalmi ${a}…${b}: ${rows} row(s)`);
    },
  });
  return { ran: true, totalRows };
}
