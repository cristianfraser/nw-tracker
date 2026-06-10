/**
 * `fund_unit_daily` helpers — one row per calendar day for rates charts (no forward-fill gaps in DB).
 */
import { db } from "./db.js";

export function ymdAddDays(ymd: string, deltaDays: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) throw new Error(`Invalid YYYY-MM-DD: ${ymd}`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + deltaDays, 12, 0, 0, 0);
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function latestFundUnitRow(
  seriesKey: string
): { day: string; unit_value_clp: number; note: string } | null {
  const r = db
    .prepare(
      `SELECT day, unit_value_clp, COALESCE(note, '') AS note FROM fund_unit_daily
       WHERE series_key = ? ORDER BY day DESC LIMIT 1`
    )
    .get(seriesKey) as { day: string; unit_value_clp: number; note: string } | undefined;
  if (r == null || !Number.isFinite(r.unit_value_clp) || r.unit_value_clp <= 0) return null;
  return r;
}

/** Insert missing calendar days in (fromExclusive, toExclusive) with a fixed unit value. */
export function fillFundUnitDailyCalendarGap(opts: {
  seriesKey: string;
  fromDayExclusive: string;
  toDayExclusive: string;
  unitValueClp: number;
  note: string;
  dryRun: boolean;
}): number {
  if (opts.fromDayExclusive >= opts.toDayExclusive) return 0;
  const ins = db.prepare(
    `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note) VALUES (?,?,?,?)
     ON CONFLICT(series_key, day) DO NOTHING`
  );
  let n = 0;
  let d = ymdAddDays(opts.fromDayExclusive, 1);
  while (d < opts.toDayExclusive) {
    if (!opts.dryRun) {
      const r = ins.run(opts.seriesKey, d, opts.unitValueClp, opts.note);
      n += r.changes;
    } else {
      n += 1;
    }
    d = ymdAddDays(d, 1);
  }
  return n;
}

/**
 * Record a spot observation: carry the previous published unit across any missing calendar days,
 * then upsert the new day (updates same day if price changed).
 */
export function upsertFundUnitSpotPreservingHistory(opts: {
  seriesKey: string;
  observationDay: string;
  unitValueClp: number;
  note: string;
  dryRun: boolean;
  carryNote?: string;
}): { gapDaysFilled: number } {
  const px = Math.round(opts.unitValueClp * 10000) / 10000;
  const prev = latestFundUnitRow(opts.seriesKey);
  let gapDaysFilled = 0;

  if (prev && prev.day < opts.observationDay && Math.abs(prev.unit_value_clp - px) > 0.005) {
    gapDaysFilled = fillFundUnitDailyCalendarGap({
      seriesKey: opts.seriesKey,
      fromDayExclusive: prev.day,
      toDayExclusive: opts.observationDay,
      unitValueClp: prev.unit_value_clp,
      note: opts.carryNote ?? "spot:carry-forward",
      dryRun: opts.dryRun,
    });
  }

  if (!opts.dryRun) {
    db.prepare(
      `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note) VALUES (?,?,?,?)
       ON CONFLICT(series_key, day) DO UPDATE SET unit_value_clp = excluded.unit_value_clp, note = excluded.note`
    ).run(opts.seriesKey, opts.observationDay, px, opts.note);
  }

  return { gapDaysFilled };
}

export function countFundUnitRowsInRange(seriesKey: string, fromYmd: string, toYmd: string): number {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS c FROM fund_unit_daily
       WHERE series_key = ? AND day >= ? AND day <= ?`
    )
    .get(seriesKey, fromYmd, toYmd) as { c: number };
  return r?.c ?? 0;
}
