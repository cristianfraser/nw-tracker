import { isNyseTradingDay } from "./marketHolidays.js";

const NY_TZ = "America/New_York";

export type NyseWallClock = {
  ymd: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

export function nyseWallClock(now: Date = new Date()): NyseWallClock {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: NY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(now);
  const g = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value;
  const y = g("year");
  const m = g("month");
  const d = g("day");
  const h = g("hour");
  const min = g("minute");
  const wd = g("weekday");
  if (!y || !m || !d || h == null || min == null) {
    throw new Error("Could not read NY wall clock");
  }
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    ymd: `${y}-${m}-${d}`,
    year: parseInt(y, 10),
    month: parseInt(m, 10),
    day: parseInt(d, 10),
    hour: parseInt(h, 10),
    minute: parseInt(min, 10),
    weekday: weekdayMap[wd ?? ""] ?? 0,
  };
}

/** Unix seconds → `YYYY-MM-DD` in America/New_York (for Yahoo daily bars). */
export function nyseYmdFromUnix(sec: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: NY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(sec * 1000));
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  if (!y || !m || !d) throw new Error("nyseYmdFromUnix failed");
  return `${y}-${m}-${d}`;
}

/** Current NYSE session label: last trading day on or before NY today. */
export function nyseSessionYmd(now: Date = new Date()): string {
  const ny = nyseWallClock(now);
  if (isNyseTradingDay(ny.ymd)) return ny.ymd;
  let cur = ny.ymd;
  for (let i = 0; i < 12; i++) {
    const [y, m, d] = cur.split("-").map(Number);
    const dt = new Date(Date.UTC(y!, m! - 1, d! - 1));
    cur = dt.toISOString().slice(0, 10);
    if (isNyseTradingDay(cur)) return cur;
  }
  return ny.ymd;
}

/** Regular cash session close 16:00 America/New_York (4pm ET). */
export function isAfterNyseRegularClose(now: Date = new Date()): boolean {
  const ny = nyseWallClock(now);
  if (!isNyseTradingDay(ny.ymd)) return false;
  return ny.hour > 16 || (ny.hour === 16 && ny.minute >= 5);
}

export function utcTodayYmd(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
