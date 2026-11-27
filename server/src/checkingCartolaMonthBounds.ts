/**
 * The days a cartola month is measured on, from its printed period (DESDE / HASTA). Santander's
 * DESDE is the previous statement's close: the opening balance is the balance at the end of that
 * day (a DESDE on the 1st opens the period on that day, as `effectiveCartolaStartYm` reads it), and HASTA is the day of the closing balance (the month's last bank day). A cuenta vista
 * document that spans several months is split per calendar month and every slice keeps the
 * document's DESDE / HASTA, so a slice inside the span opens at the previous calendar month's end
 * and closes at its own month's end (the daily balance the document prints there).
 *
 * Read by the anchor derivation (`checkingCartolaBalances.ts`), the import's ledger guard
 * (`checkingCartolaLedgerGuard.ts`) and the second-document cross-check
 * (`checkingCartolaCrossCheck.ts`).
 */
import { addCalendarMonths, monthEndUtcYmd } from "nw-tracker-contracts";

export type CartolaMonthPeriod = { period_month: string; period_from: string | null; period_to: string | null };

function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The day whose closing balance is the month's opening balance. */
export function cartolaOpeningDay(p: CartolaMonthPeriod): string {
  const prev = addCalendarMonths(p.period_month, -1);
  const from = p.period_from;
  if (from == null || from < `${prev}-01` || from === `${p.period_month}-01`) return monthEndUtcYmd(prev);
  return from;
}

/** The day of the month's closing balance. */
export function cartolaClosingDay(p: CartolaMonthPeriod): string {
  const end = monthEndUtcYmd(p.period_month);
  const to = p.period_to;
  if (to == null || to > end) return end;
  return to;
}

/**
 * How far before the calendar month end a HASTA may fall and still be the month's close: Santander
 * closes on the month's last bank day, and the longest run of non-bank days that ends a month is
 * three (a Thursday close before Good Friday and the weekend; a Friday close before a Monday 31
 * December), so a HASTA earlier than the month's last week ends the document inside the month.
 */
export const MONTH_CLOSE_WINDOW_DAYS = 7;

/**
 * Whether the document's period covers the whole calendar month: it opens at a close before the
 * month (DESDE in an earlier month or on its 1st, or none printed: the monthly xlsx) and closes at the month's
 * close or later (HASTA in the month's last week, in a later month, or none printed). A DESDE
 * inside the month (the boundary slice of a straddling cuenta vista document) or a HASTA before the
 * month's last week is a document that covers part of the month.
 */
export function cartolaCoversWholeMonth(p: CartolaMonthPeriod): boolean {
  const opensBefore = p.period_from == null || p.period_from <= `${p.period_month}-01`;
  const lastWeek = addDaysYmd(monthEndUtcYmd(p.period_month), -(MONTH_CLOSE_WINDOW_DAYS - 1));
  const closesAtEnd = p.period_to == null || p.period_to >= lastWeek;
  return opensBefore && closesAtEnd;
}
