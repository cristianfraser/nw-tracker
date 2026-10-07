/**
 * The AFP account's UNO Fondo A valor cuota, read from the Superintendencia de Pensiones
 * (`spAfpFundUnits.ts`) and written to `afp_uno_cuota_a` in the display frame
 * (`afpDisplayFrame.ts`): the official value of business day D shows from the next Chile
 * business day, the day it is published.
 *
 * Measured 2026-10-03 → 06: the SP printed Friday 10-02's value on Monday 10-05 at ~18:48
 * (the row existed blank from ~16:07); uno.cl's homepage showed it at ~21:59. So the value of D
 * is due from {@link AFP_UNO_PUBLISH_HOUR_CHILE} on the business day after D, and the sync polls
 * the SP from then until it lands. Every run re-reads the whole current year: the SP's trailing
 * days are «provisorios» and a restated value replaces the stored one (reported as a step note).
 */
import { AFP_UNO_CUOTA_SERIES_KEY } from "./afpUnoSeries.js";
import { afpDisplayDayForOfficialDay, buildAfpDisplaySeries, type DisplayFundUnit } from "./afpDisplayFrame.js";
import { chileCalendarAddDays, type ChileWallClock } from "./chileDate.js";
import { db } from "./db.js";
import { isChileBusinessDay, nextChileBusinessDayYmd, priorChileBusinessDayYmd } from "./marketHolidays.js";
import {
  fetchSpAfpFundUnits,
  officialPensionFundUnits,
  upsertSpAfpFundUnits,
  type SpAfpRestatement,
} from "./spAfpFundUnits.js";

/** Business days between an official day and the day it shows (the SP publishes D on D+1). */
export const AFP_UNO_DISPLAY_LAG_BUSINESS_DAYS = 1;

/**
 * Chile hour from which the previous business day's official value is expected: 18:00, the same
 * hour as Fintual's cuota (`FINTUAL_PUBLISH_HOUR_CHILE`), so both funds turn stale and dim
 * together. The SP prints the value ~18:30–18:50, so the source waits as publisher lag until it lands.
 */
export const AFP_UNO_PUBLISH_HOUR_CHILE = 18;

const UNO = "uno";
const FUND = "A" as const;
/** Display days re-derived on every run (covers the SP's provisional tail and any restatement). */
const DISPLAY_REWRITE_DAYS = 60;

/**
 * The business day whose official value must be in DB at `cl`: the business day before the
 * latest business day whose publish hour has passed (today from 18:00, else the business day
 * before today).
 */
export function afpUnoExpectedOfficialDay(cl: ChileWallClock): string {
  const latestPublishDay =
    isChileBusinessDay(cl.ymd) && cl.hour >= AFP_UNO_PUBLISH_HOUR_CHILE ? cl.ymd : priorChileBusinessDayYmd(cl.ymd);
  if (!latestPublishDay) throw new Error(`afp_uno: no Chile business day before ${cl.ymd}`);
  let d = latestPublishDay;
  for (let i = 0; i < AFP_UNO_DISPLAY_LAG_BUSINESS_DAYS; i++) {
    const prior = priorChileBusinessDayYmd(d);
    if (!prior) throw new Error(`afp_uno: no Chile business day before ${d}`);
    d = prior;
  }
  return d;
}

export function latestOfficialUnoDay(): string | null {
  const row = db
    .prepare(`SELECT MAX(day) AS day FROM pension_fund_unit_official WHERE afp = ? AND fund = ?`)
    .get(UNO, FUND) as { day: string | null };
  return row.day;
}

/** Stale = the expected official day is not in DB. */
export function isAfpUnoOfficialStale(cl: ChileWallClock, latestOfficialDay: string | null): boolean {
  const expected = afpUnoExpectedOfficialDay(cl);
  return latestOfficialDay == null || latestOfficialDay < expected;
}

/**
 * When the source next becomes stale: the publish hour of the next business day whose expected
 * official day is beyond `latestOfficialDay` — today when today is a business day before its
 * publish hour, else the following business days.
 */
export function afpUnoNextDue(cl: ChileWallClock, latestOfficialDay: string | null): { ymd: string; hour: number } | null {
  let d = isChileBusinessDay(cl.ymd) && cl.hour < AFP_UNO_PUBLISH_HOUR_CHILE ? cl.ymd : nextChileBusinessDayYmd(cl.ymd);
  for (let i = 0; d != null && i < 21; i++) {
    const expected = afpUnoExpectedOfficialDay({ ...cl, ymd: d, hour: AFP_UNO_PUBLISH_HOUR_CHILE, minute: 0 });
    if (latestOfficialDay == null || expected > latestOfficialDay) return { ymd: d, hour: AFP_UNO_PUBLISH_HOUR_CHILE };
    d = nextChileBusinessDayYmd(d);
  }
  return null;
}

export type AfpUnoOfficialSyncResult = {
  years: number[];
  /** Latest day the SP printed a UNO value at this fetch (its publication frontier). */
  published_ymd: string | null;
  official_restated: SpAfpRestatement[];
  /** Display days whose stored value changed (a new day, or one the SP restated). */
  display_written: number;
  display_restated: { day: string; previous: number; next: number }[];
  /** The last display row written: the value shown today (readers carry it forward). */
  latest_display: DisplayFundUnit | null;
};

const stmtDisplayRow = db.prepare(`SELECT unit_value_clp FROM fund_unit_daily WHERE series_key = ? AND day = ?`);
const stmtUpsertDisplay = db.prepare(
  `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note) VALUES (?, ?, ?, ?)
   ON CONFLICT(series_key, day) DO UPDATE SET unit_value_clp = excluded.unit_value_clp, note = excluded.note`
);

export function afpUnoDisplayNote(r: DisplayFundUnit): string {
  return `sp:official|afp=uno|official=${r.official_day}|lag=${AFP_UNO_DISPLAY_LAG_BUSINESS_DAYS}`;
}

/** Write display rows; returns the rows that changed a stored value. */
export function upsertAfpUnoDisplayRows(
  rows: readonly DisplayFundUnit[],
  dryRun: boolean
): { written: number; restated: { day: string; previous: number; next: number }[] } {
  let written = 0;
  const restated: { day: string; previous: number; next: number }[] = [];
  const run = () => {
    for (const r of rows) {
      const prev = stmtDisplayRow.get(AFP_UNO_CUOTA_SERIES_KEY, r.day) as { unit_value_clp: number } | undefined;
      if (prev && Math.abs(prev.unit_value_clp - r.unit_value_clp) <= 0.005) continue;
      if (prev) restated.push({ day: r.day, previous: prev.unit_value_clp, next: r.unit_value_clp });
      written += 1;
      if (!dryRun) stmtUpsertDisplay.run(AFP_UNO_CUOTA_SERIES_KEY, r.day, r.unit_value_clp, afpUnoDisplayNote(r));
    }
  };
  if (dryRun) run();
  else db.transaction(run)();
  return { written, restated };
}

/**
 * Fetch fund A for the current year (plus the previous one while its last day is not stored),
 * store every AFP's official values, and re-derive UNO's display rows of the last
 * {@link DISPLAY_REWRITE_DAYS} days through today.
 */
export async function syncAfpUnoFromSp(opts: {
  cl: ChileWallClock;
  dryRun: boolean;
  signal?: AbortSignal;
}): Promise<AfpUnoOfficialSyncResult> {
  const year = opts.cl.year;
  const latestBefore = latestOfficialUnoDay();
  const fromYear = latestBefore != null && latestBefore >= `${year - 1}-12-31` ? year : year - 1;
  const fetched = await fetchSpAfpFundUnits(FUND, fromYear, year, opts.cl.ymd, { signal: opts.signal });
  const unoFetched = fetched.filter((r) => r.afp === UNO);
  if (unoFetched.length === 0) throw new Error(`afp_uno: the SP file for ${fromYear}–${year} carries no UNO column`);
  const official = upsertSpAfpFundUnits(fetched, { dryRun: opts.dryRun });
  const published_ymd = unoFetched.reduce((m, r) => (r.day > m ? r.day : m), unoFetched[0]!.day);

  // In dry-run the stored series lacks this fetch's new days, so derive from the fetched rows.
  const series = opts.dryRun
    ? unoFetched.map((r) => ({ day: r.day, unit_value_clp: r.unit_value_clp }))
    : officialPensionFundUnits(UNO, FUND);
  // Rows go only through the day the latest published value shows: while the next one is
  // pending, today has no row of its own (readers take the value on or before), so the
  // value's arrival is a new row, never a «restatement» of a carried one.
  const lastValued = [...series].reverse().find((r) => isChileBusinessDay(r.day));
  if (!lastValued) throw new Error("afp_uno: the official UNO series has no business-day value");
  const throughDay = minYmd(opts.cl.ymd, afpDisplayDayForOfficialDay(lastValued.day, AFP_UNO_DISPLAY_LAG_BUSINESS_DAYS));
  const fromDay = chileCalendarAddDays(opts.cl.ymd, -DISPLAY_REWRITE_DAYS);
  const display = buildAfpDisplaySeries(series, AFP_UNO_DISPLAY_LAG_BUSINESS_DAYS, throughDay).filter(
    (r) => r.day >= fromDay
  );
  const written = upsertAfpUnoDisplayRows(display, opts.dryRun);
  return {
    years: fromYear === year ? [year] : [fromYear, year],
    published_ymd,
    official_restated: official.restated.filter((r) => r.afp === UNO),
    display_written: written.written,
    display_restated: written.restated,
    latest_display: display.at(-1) ?? null,
  };
}

function minYmd(a: string, b: string): string {
  return a < b ? a : b;
}
