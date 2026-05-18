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

export function chileWallClockNow(): ChileWallClock {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
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

export function chileCalendarTodayYmd(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  if (!y || !m || !d) {
    throw new Error("Could not format Chile date");
  }
  return `${y}-${m}-${d}`;
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
