/**
 * `fund_unit_daily` helpers — one row per calendar day for rates charts (no forward-fill gaps in DB).
 *
 * A row's `unit_value` is a quantity of its `currency` (migration 257): every series the app
 * syncs is quoted in pesos; a dollar fund (a 401(k)'s target-date fund, docs/demo-us-chapter-plan.md)
 * is quoted in dollars. A series is one currency: a write in another one throws, and so does a read
 * of a series that holds two. Readers built for peso series ({@link assertFundSeriesClp}) refuse a
 * series in another currency; the holding price (`holdingPrices.ts`) prices a fund in its own.
 */
import { db } from "./db.js";
import { dbStateMemo } from "./dbStateMemo.js";
import type { CurrencyCode } from "./rates.js";

const FUND_UNIT_CURRENCIES: ReadonlySet<string> = new Set(["clp", "usd", "uf", "eur"]);

const stmtSeriesCurrencies = db.prepare(
  `SELECT MIN(currency) AS lo, MAX(currency) AS hi FROM fund_unit_daily WHERE series_key = ?`
);

/** The currency a series is quoted in; null while it has no row. Throws on a series in two currencies. */
export function fundSeriesCurrency(seriesKey: string): CurrencyCode | null {
  return dbStateMemo("fund_series_currency", seriesKey, () => {
    const r = stmtSeriesCurrencies.get(seriesKey) as { lo: string | null; hi: string | null } | undefined;
    if (r?.lo == null) return null;
    if (r.lo !== r.hi) {
      throw new Error(`fund_unit_daily: series ${seriesKey} holds rows in two currencies (${r.lo}, ${r.hi})`);
    }
    if (!FUND_UNIT_CURRENCIES.has(r.lo)) throw new Error(`fund_unit_daily: series ${seriesKey} has currency «${r.lo}»`);
    return r.lo as CurrencyCode;
  });
}

/**
 * For a reader built for peso series: throws when `seriesKey` is quoted in another currency (a
 * series with no row passes — it has nothing to read).
 */
export function assertFundSeriesClp(seriesKey: string, reader: string): void {
  const c = fundSeriesCurrency(seriesKey);
  if (c != null && c !== "clp") {
    throw new Error(`${reader}: fund series ${seriesKey} is quoted in ${c.toUpperCase()}; this reader reads peso series only`);
  }
}

/** A write in `currency` to `seriesKey`: throws when the series already holds another currency. */
function assertSeriesWritableIn(seriesKey: string, currency: CurrencyCode): void {
  const c = fundSeriesCurrency(seriesKey);
  if (c != null && c !== currency) {
    throw new Error(
      `fund_unit_daily: series ${seriesKey} is quoted in ${c.toUpperCase()}; refusing a ${currency.toUpperCase()} row`
    );
  }
}

/** Certificate scratch rows (`monto / cuotas` per movement line): never a display price. */
export const AFP_CERT_FUND_UNIT_SCRATCH = "afp-cert:monto/cuotas_delta";

/**
 * The display valor cuota on or before `ymd`, in the series' currency: the newest quoted row
 * (certificate scratch rows skipped within the 60 most recent), else the newest row of any kind.
 */
export function fundUnitRowOnOrBeforeForDisplay(
  seriesKey: string,
  ymd: string
): { day: string; unit_value: number; currency: CurrencyCode } | null {
  const currency = fundSeriesCurrency(seriesKey);
  if (currency == null) return null;
  const rows = db
    .prepare(
      `SELECT day, unit_value, COALESCE(note, '') AS note FROM fund_unit_daily
       WHERE series_key = ? AND day <= ?
       ORDER BY day DESC
       LIMIT 60`
    )
    .all(seriesKey, ymd) as { day: string; unit_value: number; note: string }[];
  const valid = (r: { day: string; unit_value: number }) =>
    r.day && r.unit_value != null && Number.isFinite(r.unit_value) && r.unit_value > 0;
  for (const r of rows) {
    if (!r.note.includes(AFP_CERT_FUND_UNIT_SCRATCH) && valid(r)) return { day: r.day, unit_value: r.unit_value, currency };
  }
  const any = db
    .prepare(
      `SELECT day, unit_value FROM fund_unit_daily
       WHERE series_key = ? AND day <= ?
       ORDER BY day DESC LIMIT 1`
    )
    .get(seriesKey, ymd) as { day: string; unit_value: number } | undefined;
  return any && valid(any) ? { day: any.day, unit_value: any.unit_value, currency } : null;
}

/**
 * Writes a series' rows in `currency` (insert or replace the day's value and note) — the writer
 * for a series quoted in another currency than pesos. Throws when the series holds another one.
 */
export function writeFundUnitSeriesRows(opts: {
  seriesKey: string;
  currency: CurrencyCode;
  rows: readonly { day: string; unit_value: number; note?: string | null }[];
}): number {
  assertSeriesWritableIn(opts.seriesKey, opts.currency);
  const up = db.prepare(
    `INSERT INTO fund_unit_daily (series_key, day, unit_value, currency, note) VALUES (?,?,?,?,?)
     ON CONFLICT(series_key, day) DO UPDATE SET unit_value = excluded.unit_value, note = excluded.note`
  );
  let n = 0;
  for (const r of opts.rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.day)) throw new Error(`fund_unit_daily: invalid day ${r.day}`);
    if (!(Number.isFinite(r.unit_value) && r.unit_value > 0)) {
      throw new Error(`fund_unit_daily: ${opts.seriesKey} ${r.day}: unit value ${r.unit_value} is not positive`);
    }
    n += up.run(opts.seriesKey, r.day, r.unit_value, opts.currency, r.note ?? null).changes;
  }
  return n;
}

export function ymdAddDays(ymd: string, deltaDays: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) throw new Error(`Invalid YYYY-MM-DD: ${ymd}`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + deltaDays, 12, 0, 0, 0);
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function latestFundUnitRowAnyCurrency(seriesKey: string): { day: string; unit_value: number } | null {
  const r = db
    .prepare(`SELECT day, unit_value FROM fund_unit_daily WHERE series_key = ? ORDER BY day DESC LIMIT 1`)
    .get(seriesKey) as { day: string; unit_value: number } | undefined;
  return r != null && Number.isFinite(r.unit_value) && r.unit_value > 0 ? r : null;
}

/** The newest row of a peso series. */
export function latestFundUnitRow(
  seriesKey: string
): { day: string; unit_value: number; note: string } | null {
  assertFundSeriesClp(seriesKey, "latestFundUnitRow");
  const r = db
    .prepare(
      `SELECT day, unit_value, COALESCE(note, '') AS note FROM fund_unit_daily
       WHERE series_key = ? ORDER BY day DESC LIMIT 1`
    )
    .get(seriesKey) as { day: string; unit_value: number; note: string } | undefined;
  if (r == null || !Number.isFinite(r.unit_value) || r.unit_value <= 0) return null;
  return r;
}

/** Valor cuota (CLP) for a series on or before `ymd` — nearest prior day with a positive value. */
export function fundUnitClpOnOrBefore(seriesKey: string, ymd: string): number | null {
  assertFundSeriesClp(seriesKey, "fundUnitClpOnOrBefore");
  const r = db
    .prepare(
      `SELECT unit_value FROM fund_unit_daily
       WHERE series_key = ? AND day <= ? AND unit_value > 0
       ORDER BY day DESC LIMIT 1`
    )
    .get(seriesKey, ymd) as { unit_value: number } | undefined;
  const v = r?.unit_value;
  return v != null && Number.isFinite(v) && v > 0 ? v : null;
}

/** Insert missing calendar days in (fromExclusive, toExclusive) with a fixed unit value. */
export function fillFundUnitDailyCalendarGap(opts: {
  seriesKey: string;
  fromDayExclusive: string;
  toDayExclusive: string;
  unitValueClp: number;
  note: string;
  dryRun: boolean;
  /** The series' quote currency (pesos unless stated). */
  currency?: CurrencyCode;
}): number {
  if (opts.fromDayExclusive >= opts.toDayExclusive) return 0;
  const currency = opts.currency ?? "clp";
  assertSeriesWritableIn(opts.seriesKey, currency);
  const ins = db.prepare(
    `INSERT INTO fund_unit_daily (series_key, day, unit_value, currency, note) VALUES (?,?,?,?,?)
     ON CONFLICT(series_key, day) DO NOTHING`
  );
  let n = 0;
  let d = ymdAddDays(opts.fromDayExclusive, 1);
  while (d < opts.toDayExclusive) {
    if (!opts.dryRun) {
      const r = ins.run(opts.seriesKey, d, opts.unitValueClp, currency, opts.note);
      n += r.changes;
    } else {
      n += 1;
    }
    d = ymdAddDays(d, 1);
  }
  return n;
}

/**
 * Record a spot observation: fill any missing calendar days between the last stored day and the
 * observation, then upsert the new day (updates same day if price changed).
 *
 * `gapFill` decides what the gap days hold:
 * - `"carry_previous"` (default): the previous stored value under `carryNote`; only when the new
 *   value differs from it by more than half a cent (an equal value needs no placeholder rows).
 * - `"stand_in_new"`: the NEW value under `standInNote` (required), whenever the gap is non-empty.
 *   For a source whose observation can stand for days it skipped (Fintual's weekend block value),
 *   where carrying the old value would put the whole move on the observation day. The rows are
 *   placeholders a later observation or an official serie overwrites; filling on equal values too
 *   keeps the rule simple and the placeholders identifiable.
 */
export function upsertFundUnitSpotPreservingHistory(opts: {
  seriesKey: string;
  observationDay: string;
  unitValueClp: number;
  note: string;
  dryRun: boolean;
  carryNote?: string;
  gapFill?: "carry_previous" | "stand_in_new";
  standInNote?: string;
  /** The series' quote currency (pesos unless stated). */
  currency?: CurrencyCode;
}): { gapDaysFilled: number } {
  const currency = opts.currency ?? "clp";
  assertSeriesWritableIn(opts.seriesKey, currency);
  const px = Math.round(opts.unitValueClp * 10000) / 10000;
  const prev = latestFundUnitRowAnyCurrency(opts.seriesKey);
  let gapDaysFilled = 0;
  const mode = opts.gapFill ?? "carry_previous";
  if (mode === "stand_in_new" && !opts.standInNote) {
    throw new Error(`upsertFundUnitSpotPreservingHistory(${opts.seriesKey}): gapFill "stand_in_new" requires standInNote`);
  }

  if (prev && prev.day < opts.observationDay) {
    if (mode === "stand_in_new") {
      gapDaysFilled = fillFundUnitDailyCalendarGap({
        seriesKey: opts.seriesKey,
        fromDayExclusive: prev.day,
        toDayExclusive: opts.observationDay,
        unitValueClp: px,
        note: opts.standInNote!,
        dryRun: opts.dryRun,
        currency,
      });
    } else if (Math.abs(prev.unit_value - px) > 0.005) {
      gapDaysFilled = fillFundUnitDailyCalendarGap({
        seriesKey: opts.seriesKey,
        fromDayExclusive: prev.day,
        toDayExclusive: opts.observationDay,
        unitValueClp: prev.unit_value,
        note: opts.carryNote ?? "spot:carry-forward",
        dryRun: opts.dryRun,
        currency,
      });
    }
  }

  if (!opts.dryRun) {
    db.prepare(
      `INSERT INTO fund_unit_daily (series_key, day, unit_value, currency, note) VALUES (?,?,?,?,?)
       ON CONFLICT(series_key, day) DO UPDATE SET unit_value = excluded.unit_value, note = excluded.note`
    ).run(opts.seriesKey, opts.observationDay, px, currency, opts.note);
  }

  return { gapDaysFilled };
}

/** Rows of a series in [from, to] (any currency: a count). */
export function countFundUnitRowsInRange(seriesKey: string, fromYmd: string, toYmd: string): number {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS c FROM fund_unit_daily
       WHERE series_key = ? AND day >= ? AND day <= ?`
    )
    .get(seriesKey, fromYmd, toYmd) as { c: number };
  return r?.c ?? 0;
}
