/**
 * Calendar days as `YYYY-MM-DD` strings: validation, the printed dd/mm/yy forms, and day
 * arithmetic. Days are calendar days (UTC arithmetic on the date, no time zone): a Chile day is
 * already a calendar day once it is a string. Everything throws on a malformed day — a bad date is
 * a parser or data problem, never a distance of «999 days».
 */

export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` for a real calendar day, else null (month 13, February 30). */
export function calendarDateIso(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Whether `raw` is a `YYYY-MM-DD` real calendar day. */
export function isIsoDate(raw: string): boolean {
  if (typeof raw !== "string" || !ISO_DATE_PATTERN.test(raw)) return false;
  return calendarDateIso(Number(raw.slice(0, 4)), Number(raw.slice(5, 7)), Number(raw.slice(8, 10))) === raw;
}

/** `raw` itself when it is a real `YYYY-MM-DD` day; throws otherwise. */
export function requireIsoDate(raw: string, what = "date"): string {
  if (!isIsoDate(raw)) throw new Error(`Expected a YYYY-MM-DD ${what}, got ${JSON.stringify(raw)}`);
  return raw;
}

/** Days since 1970-01-01 of a `YYYY-MM-DD` day. */
export function isoDayNumber(ymd: string): number {
  return Date.parse(`${requireIsoDate(ymd)}T00:00:00Z`) / MS_PER_DAY;
}

/** `ymd` moved by `days` calendar days. */
export function addDaysIso(ymd: string, days: number): string {
  if (!Number.isInteger(days)) throw new Error(`addDaysIso: ${days} is not a whole number of days`);
  return new Date((isoDayNumber(ymd) + days) * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Calendar days from `fromYmd` to `toYmd`: positive when `toYmd` is later. */
export function daysBetweenIso(fromYmd: string, toYmd: string): number {
  return isoDayNumber(toYmd) - isoDayNumber(fromYmd);
}

/**
 * Whether `candidateYmd` lies inside a window around `anchorYmd`: from `daysBefore` days before it
 * to `daysAfter` days after it, both inclusive. The one place a day window is read.
 */
export function dayWithinWindow(
  anchorYmd: string,
  candidateYmd: string,
  window: { daysBefore: number; daysAfter: number }
): boolean {
  const gap = daysBetweenIso(anchorYmd, candidateYmd);
  return gap >= -window.daysBefore && gap <= window.daysAfter;
}

/**
 * `ymd` moved forward by `n` business days (`n` ≥ 0), where `isBusinessDay` is the calendar's test —
 * a market-holiday calendar lives on the server, so it is passed in rather than imported here.
 */
export function addBusinessDaysIso(ymd: string, n: number, isBusinessDay: (ymd: string) => boolean): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`addBusinessDaysIso: ${n} is not a whole number of days ≥ 0`);
  let cur = requireIsoDate(ymd);
  let left = n;
  while (left > 0) {
    cur = addDaysIso(cur, 1);
    if (isBusinessDay(cur)) left--;
  }
  return cur;
}

const DD_MM = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;
/** pypdf can merge DD/MM/YY with MCC digits (e.g. 13/05/2511001SANTIAG). */
const TX_DATE_MAX_PLAUSIBLE_YEAR = 2038;

function normalizeTxDateDdMm(raw: string): string {
  const t = String(raw ?? "").trim();
  const m = DD_MM.exec(t);
  if (!m) return t;
  const ypart = m[3]!;
  if (ypart.length === 2) return t;
  const y = Number(ypart);
  if (y >= 1990 && y <= TX_DATE_MAX_PLAUSIBLE_YEAR) return t;
  return `${m[1]}/${m[2]}/${ypart.slice(0, 2)}`;
}

/**
 * `dd/mm/yyyy` or `dd/mm/yy` (or an ISO date, as is) → `YYYY-MM-DD`; null when it is neither.
 * A four-digit year past 2038 is a parser token jammed onto the date and reads as its first two
 * digits. Python's `parse_dd_mm_yy_to_iso` and this assert `server/contracts/data/ddMmYyToIsoCases.json`.
 */
export function parseDdMmYyToIso(raw: string): string | null {
  const t = normalizeTxDateDdMm(String(raw ?? "").trim());
  if (ISO_DATE_PATTERN.test(t)) return t;
  const m = DD_MM.exec(t);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  let y = Number(m[3]);
  if (y < 100) y += y >= 70 ? 1900 : 2000;
  if (!Number.isFinite(d) || !Number.isFinite(mo) || !Number.isFinite(y)) return null;
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` → `dd/mm/yyyy`; throws on anything else. */
export function ddMmYyyyFromIso(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`ddMmYyyyFromIso: expected YYYY-MM-DD, got ${JSON.stringify(iso)}`);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/**
 * The date of a cartola movement printed as `day`/`month` (no year), from the statement's own
 * period DESDE..HASTA (ISO, inclusive): the candidates are the years from DESDE's to HASTA's where
 * dd/mm is a real date inside the period. Exactly one is the date; none (outside the period), several
 * (a period over a year) or a missing bound throw. `where` (file and row) prefixes the error. The
 * Python parsers and this assert `server/contracts/data/cartolaMovementYearCases.json`.
 */
export function cartolaMovementDateIso(
  day: number,
  month: number,
  period: { desde: string | null; hasta: string | null },
  where?: string
): string {
  const dayMonth = `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}`;
  const label = `${where ? `${where}: ` : ""}cartola movement ${dayMonth}`;
  const { desde, hasta } = period;
  if (!desde) throw new Error(`${label}: the period start (DESDE) is missing`);
  if (!hasta) throw new Error(`${label}: the period end (HASTA) is missing`);
  if (!ISO_DATE_PATTERN.test(desde) || !ISO_DATE_PATTERN.test(hasta) || desde > hasta) {
    throw new Error(`${label}: bad period ${desde}..${hasta}`);
  }
  const candidates: string[] = [];
  for (let year = Number(desde.slice(0, 4)); year <= Number(hasta.slice(0, 4)); year++) {
    const iso = calendarDateIso(year, month, day);
    if (iso && iso >= desde && iso <= hasta) candidates.push(iso);
  }
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    throw new Error(`${label} is not a date inside the period ${desde}..${hasta}`);
  }
  throw new Error(`${label} is ambiguous: ${candidates.join(" and ")} are inside the period ${desde}..${hasta}`);
}
