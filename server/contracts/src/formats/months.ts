/**
 * Calendar months as `YYYY-MM` strings, and the Spanish month names documents print.
 */
import { foldAccents } from "./text.js";

const YEAR_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Parse YYYY-MM (years 1990–2100); returns null if invalid. */
export function parseYearMonth(s: string): string | null {
  const t = String(s ?? "").trim();
  if (!/^\d{4}-\d{2}$/.test(t)) return null;
  const [y, m] = t.split("-").map(Number) as [number, number];
  if (m < 1 || m > 12 || y < 1990 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** Add whole calendar months to a YYYY-MM anchor. Throws on anything but `YYYY-MM`. */
export function addCalendarMonths(ym: string, delta: number): string {
  if (!YEAR_MONTH_PATTERN.test(ym)) throw new Error(`addCalendarMonths: expected YYYY-MM, got ${JSON.stringify(ym)}`);
  if (!Number.isInteger(delta)) throw new Error(`addCalendarMonths: ${delta} is not a whole number of months`);
  // Months since year 0, then back: the same as moving a UTC date's month, without a Date.
  const index = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + delta;
  const year = Math.floor(index / 12);
  return `${year}-${String(index - year * 12 + 1).padStart(2, "0")}`;
}

/** `YYYY-MM` from `YYYY-MM-DD`. */
export function monthKeyFromYmd(ymd: string): string {
  return ymd.slice(0, 7);
}

export function ymCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const monthEndByMonthKey = new Map<string, string>();

/** Last calendar day of month for `YYYY-MM`. Throws on malformed input. */
export function monthEndUtcYmd(monthKey: string): string {
  const hit = monthEndByMonthKey.get(monthKey);
  if (hit !== undefined) return hit;
  const [ys, ms] = monthKey.split("-");
  const y = Number(ys);
  const mo = Number(ms);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) {
    throw new Error(`monthEndUtcYmd: invalid month key ${JSON.stringify(monthKey)}`);
  }
  const end = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
  if (monthEndByMonthKey.size > 10_000) monthEndByMonthKey.clear();
  monthEndByMonthKey.set(monthKey, end);
  return end;
}

/** True when `ymd` is the last calendar day of its month. */
export function isLastCalendarDayOfMonth(ymd: string): boolean {
  const t = String(ymd ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
  return t === monthEndUtcYmd(monthKeyFromYmd(t));
}

/** Every `YYYY-MM` from `minYm` through `maxYm` inclusive. */
export function expandYearMonthsInclusive(minYm: string, maxYm: string): string[] {
  const out: string[] = [];
  let y = Number(minYm.slice(0, 4));
  let m = Number(minYm.slice(5, 7));
  const yEnd = Number(maxYm.slice(0, 4));
  const mEnd = Number(maxYm.slice(5, 7));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(yEnd) || !Number.isFinite(mEnd)) {
    return out;
  }
  while (y < yEnd || (y === yEnd && m <= mEnd)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** Every month-end from the month containing `minYmd` through the month of `maxYmd`, inclusive. */
export function monthEndsBetweenInclusive(minYmd: string, maxYmd: string): string[] {
  return expandYearMonthsInclusive(minYmd.slice(0, 7), maxYmd.slice(0, 7)).map(monthEndUtcYmd);
}

/** The Spanish month names, January first, lower case with accents as written. */
export const SPANISH_MONTH_NAMES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

/** 1–12 → its Spanish name («septiembre»). Throws outside 1–12. */
export function spanishMonthName(month: number): string {
  const name = SPANISH_MONTH_NAMES[month - 1];
  if (!Number.isInteger(month) || name === undefined) throw new Error(`spanishMonthName: no month ${month}`);
  return name;
}

/**
 * A Spanish month as documents print it → 1–12, or null when it names no month: the full name
 * («Septiembre», «setiembre») or its first three letters with or without a dot («sep.», «SEPT»),
 * any case, accents ignored.
 */
export function monthFromSpanishName(raw: string): number | null {
  const t = foldAccents(String(raw ?? "")).trim().toLowerCase().replace(/\.$/, "");
  if (!t) return null;
  if (t === "setiembre" || t === "sept") return 9;
  const full = SPANISH_MONTH_NAMES.indexOf(t as (typeof SPANISH_MONTH_NAMES)[number]);
  if (full >= 0) return full + 1;
  if (t.length !== 3) return null;
  const short = SPANISH_MONTH_NAMES.findIndex((n) => n.slice(0, 3) === t);
  return short >= 0 ? short + 1 : null;
}
