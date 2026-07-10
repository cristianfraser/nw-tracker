/**
 * Language-aware date labels.
 *
 * Convention: numeric dates in the app are always ISO `YYYY-MM-DD` (and
 * timestamps `YYYY-MM-DD HH:MM`) — unambiguous in any language, so they never
 * localize. Only month NAMES follow the UI language preference (es | en).
 *
 * Month helpers read `i18n.language` at call time; a language switch
 * re-renders the tree, so — same rule as format.ts / t() — do not cache their
 * output in `useMemo`/state without the language in the deps.
 *
 * Pure string parsing, no `Date` construction: the input `YYYY-MM(-DD)` is a
 * calendar label and must not shift with the browser timezone.
 */
import i18n from "./i18n";

const MONTHS_SHORT_ES = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
] as const;

const MONTHS_SHORT_EN = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function monthShort(month1: number): string {
  const months = i18n.language === "en" ? MONTHS_SHORT_EN : MONTHS_SHORT_ES;
  return months[month1 - 1]!;
}

/** `2026-12` → `dic 2026` / `Dec 2026` (tables, month pickers). */
export function formatYearMonthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  const mo = Number(m);
  if (!Number.isFinite(mo) || mo < 1 || mo > 12) return ym;
  return `${monthShort(mo)} ${y}`;
}

/** `2026-12-31` (or `2026-12`) → `dic 26` / `Dec 26` (chart X-axis ticks, tooltips). */
export function formatMonthYearShortLabel(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(dateStr.trim());
  if (!m) return dateStr;
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return dateStr;
  return `${monthShort(mo)} ${m[1]!.slice(2)}`;
}

/** Local-time `YYYY-MM-DD HH:MM` for timestamps (notifications, sync log). Language-independent. */
export function formatDateTimeLabel(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
