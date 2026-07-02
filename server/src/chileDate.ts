import { monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";

/** Chile wall clock (America/Santiago) for sync scheduling. */
export type ChileWallClock = {
  ymd: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** `YYYY-MM` */
  monthKey: string;
};

// Intl.DateTimeFormat construction costs ~20µs and these helpers run in hot per-line/per-month
// loops (dashboard builds call them tens of thousands of times) — build each formatter once.
const wallClockFormatterByTimeZone = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = wallClockFormatterByTimeZone.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    wallClockFormatterByTimeZone.set(timeZone, fmt);
  }
  return fmt;
}

const chileDateOnlyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Santiago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function chileWallClockAt(now: Date): ChileWallClock {
  const parts = wallClockFormatter("America/Santiago").formatToParts(now);
  const g = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value;
  const y = g("year");
  const m = g("month");
  const d = g("day");
  const h = g("hour");
  const min = g("minute");
  if (!y || !m || !d || h == null || min == null) {
    throw new Error("Could not read Chile wall clock");
  }
  const year = parseInt(y, 10);
  const month = parseInt(m, 10);
  const day = parseInt(d, 10);
  const hour = parseInt(h, 10);
  const minute = parseInt(min, 10);
  return {
    ymd: `${y}-${m}-${d}`,
    year,
    month,
    day,
    hour,
    minute,
    monthKey: `${y}-${m}`,
  };
}

export function chileWallClockNow(): ChileWallClock {
  return chileWallClockAt(new Date());
}

/** Calendar `YYYY-MM-DD` in America/Santiago (DST-safe via Intl). */
/** Calendar add in UTC (safe for `YYYY-MM-DD` portfolio dates; not wall-clock DST edges). */
export function chileCalendarAddDays(ymd: string, deltaDays: number): string {
  const parts = ymd.split("-").map((x) => parseInt(x, 10));
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (!y || !m || !d || !Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw new Error(`Invalid YMD: ${ymd}`);
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

/**
 * Instant when wall clock in `timeZone` reads `ymd` HH:mm (DST-safe via Intl refinement).
 */
export function dateAtTimeZoneWallClock(
  ymd: string,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
  if (!y || !m || !d || !Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw new Error(`Invalid YMD: ${ymd}`);
  }
  let ms = Date.UTC(y, m - 1, d, hour, minute);
  for (let i = 0; i < 10; i++) {
    const parts = wallClockFormatter(timeZone).formatToParts(new Date(ms));
    const g = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value;
    const wy = g("year");
    const wmo = g("month");
    const wd = g("day");
    const wh = g("hour");
    const wmin = g("minute");
    if (!wy || !wmo || !wd || wh == null || wmin == null) break;
    const wallYmd = `${wy}-${wmo}-${wd}`;
    const wallHour = parseInt(wh, 10);
    const wallMin = parseInt(wmin, 10);
    if (wallYmd === ymd && wallHour === hour && wallMin === minute) return new Date(ms);
    const targetMins = hour * 60 + minute;
    const wallMins = wallHour * 60 + wallMin;
    let dayDiff = 0;
    if (wallYmd < ymd) dayDiff = 1;
    else if (wallYmd > ymd) dayDiff = -1;
    ms += (targetMins - wallMins + dayDiff * 24 * 60) * 60_000;
  }
  return new Date(ms);
}

let todayYmdCache: { atSecond: number; ymd: string } | null = null;

export function chileCalendarTodayYmd(): string {
  const atSecond = Math.floor(Date.now() / 1000);
  if (todayYmdCache?.atSecond === atSecond) return todayYmdCache.ymd;
  const parts = chileDateOnlyFormatter.formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  if (!y || !m || !d) {
    throw new Error("Could not format Chile date");
  }
  const ymd = `${y}-${m}-${d}`;
  todayYmdCache = { atSecond, ymd };
  return ymd;
}

/**
 * Calendar month-end `YYYY-MM-DD` for the month containing Chile `today`, when that day is still in the future
 * (e.g. today `2026-05-14` → `2026-05-31`). Used to prune Excel “placeholder” valuations that would otherwise
 * sort after mid-month Fintual snapshots.
 */
export function chileFutureMonthEndPlaceholderYmd(): string | null {
  const t = chileCalendarTodayYmd();
  const me = monthEndUtcYmd(monthKeyFromYmd(t));
  return me > t ? me : null;
}
