/**
 * The London Stock Exchange's clock for the `.L` lines (`EquityMarketKind` `london`): the
 * Europe/London wall clock, a regular session 08:00–16:30 on LSE trading days
 * (`isLondonTradingDay`; the 24 / 31 December half days count as full sessions, see
 * `marketHolidays.ts`), and the session a reader prices today on. The twin of `nyseSession.ts`,
 * built on the same DST-safe wall-clock formatter.
 */
import { isLondonTradingDay, priorLondonSessionYmd } from "./marketHolidays.js";

export const LONDON_TZ = "Europe/London";

export type LondonWallClock = {
  ymd: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

const londonWallClockFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: LONDON_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hour12: false,
});

/** Memoized per UTC minute, like `chileWallClockAt` / `nyseWallClock` (minute resolution). */
const londonWallClockByMinute = new Map<number, LondonWallClock>();

export function londonWallClock(now: Date = new Date()): LondonWallClock {
  const minute = Math.floor(now.getTime() / 60_000);
  if (!Number.isFinite(minute)) return londonWallClockUncached(now);
  let clock = londonWallClockByMinute.get(minute);
  if (!clock) {
    if (londonWallClockByMinute.size >= 4096) londonWallClockByMinute.clear();
    clock = londonWallClockUncached(now);
    londonWallClockByMinute.set(minute, clock);
  }
  return { ...clock };
}

function londonWallClockUncached(now: Date): LondonWallClock {
  const parts = londonWallClockFormatter.formatToParts(now);
  const g = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value;
  const y = g("year");
  const m = g("month");
  const d = g("day");
  const h = g("hour");
  const min = g("minute");
  const wd = g("weekday");
  if (!y || !m || !d || h == null || min == null) {
    throw new Error("Could not read the London wall clock");
  }
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    ymd: `${y}-${m}-${d}`,
    year: parseInt(y, 10),
    month: parseInt(m, 10),
    day: parseInt(d, 10),
    // Intl prints "24" for midnight in some engines.
    hour: parseInt(h, 10) % 24,
    minute: parseInt(min, 10),
    weekday: weekdayMap[wd ?? ""] ?? 0,
  };
}

/** Unix seconds → `YYYY-MM-DD` in Europe/London (Yahoo prints an LSE daily bar at the 08:00 open). */
export function londonYmdFromUnix(sec: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: LONDON_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(sec * 1000));
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  if (!y || !m || !d) throw new Error("londonYmdFromUnix failed");
  return `${y}-${m}-${d}`;
}

/** Current LSE session label: the last trading day on or before London today. */
export function londonSessionYmd(now: Date = new Date()): string {
  const lon = londonWallClock(now);
  if (isLondonTradingDay(lon.ymd)) return lon.ymd;
  return priorLondonSessionYmd(lon.ymd) ?? lon.ymd;
}

export const LONDON_REGULAR_OPEN_MINUTES = 8 * 60;
export const LONDON_REGULAR_CLOSE_MINUTES = 16 * 60 + 30;

/** The LSE regular session has not started yet (before 08:00 London on a trading day). */
export function isBeforeLondonRegularOpen(now: Date = new Date()): boolean {
  const lon = londonWallClock(now);
  if (!isLondonTradingDay(lon.ymd)) return false;
  return lon.hour * 60 + lon.minute < LONDON_REGULAR_OPEN_MINUTES;
}

/** The LSE session of London today has ended (after 16:30 London on a trading day). */
export function isAfterLondonRegularClose(now: Date = new Date()): boolean {
  const lon = londonWallClock(now);
  if (!isLondonTradingDay(lon.ymd)) return false;
  return lon.hour * 60 + lon.minute > LONDON_REGULAR_CLOSE_MINUTES;
}

/** Regular session 08:00–16:30 Europe/London on an LSE trading day. */
export function isLondonRegularSessionOpen(now: Date = new Date()): boolean {
  const lon = londonWallClock(now);
  if (!isLondonTradingDay(lon.ymd)) return false;
  return !isBeforeLondonRegularOpen(now) && !isAfterLondonRegularClose(now);
}

/**
 * The LSE session whose close (or live quote) a reader shows: the prior session before the open,
 * today from the open on, the last session on a closed day.
 */
export function londonDisplaySessionYmd(now: Date = new Date()): string {
  const lon = londonWallClock(now);
  if (!isLondonTradingDay(lon.ymd)) return londonSessionYmd(now);
  if (isBeforeLondonRegularOpen(now)) return priorLondonSessionYmd(lon.ymd) ?? londonSessionYmd(now);
  return lon.ymd;
}
