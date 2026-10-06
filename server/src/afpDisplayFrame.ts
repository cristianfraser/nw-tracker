/**
 * The AFP valor cuota as the user sees it, built from the official series.
 *
 * The Superintendencia dates a valor cuota by the day the fund was valued (`spAfpFundUnits.ts`);
 * the fund manager publishes it during the next day, and the app shows it from the first sync
 * after that. The app keeps the price on the day it became visible — a move shows up when it
 * reaches the user, not days later on the official date — so the account's series is the
 * official one shifted by `lagBusinessDays` Chile business days: the official value of business
 * day D is the display value from the `lag`-th business day after D, carried over every
 * calendar day until the next one.
 *
 * Official values only change on Chile business days (a weekend or holiday prints the previous
 * value), so only those days carry a value of their own.
 */
import { chileCalendarAddDays } from "./chileDate.js";
import { isChileBusinessDay, nextChileBusinessDayYmd } from "./marketHolidays.js";

export type OfficialFundUnit = { day: string; unit_value_clp: number };
export type DisplayFundUnit = { day: string; unit_value_clp: number; official_day: string };

/** The day the official value of `officialDay` becomes visible: `lag` business days later. */
export function afpDisplayDayForOfficialDay(officialDay: string, lagBusinessDays: number): string {
  if (!Number.isInteger(lagBusinessDays) || lagBusinessDays < 0) {
    throw new Error(`afp display frame: invalid lag ${lagBusinessDays}`);
  }
  if (!isChileBusinessDay(officialDay)) {
    throw new Error(`afp display frame: ${officialDay} is not a Chile business day — it carries no value of its own`);
  }
  let d = officialDay;
  for (let i = 0; i < lagBusinessDays; i++) {
    const next = nextChileBusinessDayYmd(d);
    if (!next) throw new Error(`afp display frame: no business day after ${d}`);
    d = next;
  }
  return d;
}

/**
 * The display series, one row per calendar day from the first visible value through `throughDay`
 * (inclusive). `official` must ascend by day.
 */
export function buildAfpDisplaySeries(
  official: readonly OfficialFundUnit[],
  lagBusinessDays: number,
  throughDay: string
): DisplayFundUnit[] {
  const valued: { visible: string; official_day: string; v: number }[] = [];
  let prev = "";
  for (const r of official) {
    if (r.day <= prev) throw new Error(`afp display frame: official series not ascending at ${r.day}`);
    prev = r.day;
    if (!isChileBusinessDay(r.day)) continue;
    valued.push({ visible: afpDisplayDayForOfficialDay(r.day, lagBusinessDays), official_day: r.day, v: r.unit_value_clp });
  }
  const out: DisplayFundUnit[] = [];
  if (valued.length === 0) return out;
  let i = 0;
  for (let day = valued[0]!.visible; day <= throughDay; day = chileCalendarAddDays(day, 1)) {
    while (i + 1 < valued.length && valued[i + 1]!.visible <= day) i += 1;
    out.push({ day, unit_value_clp: valued[i]!.v, official_day: valued[i]!.official_day });
  }
  return out;
}
