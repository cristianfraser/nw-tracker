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
import { isChileBusinessDay } from "./marketHolidays.js";

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
 * The month's last bank day by the repo's Chile calendar (`isChileBusinessDay`, `marketHolidays.ts`)
 * and 31 December, a bank holiday in Chile every year. The calendar lists holidays only from 2025,
 * so for an earlier month this can name a holiday; the next month's DESDE, where on file, is the
 * bank's own statement of the close (`cartolaCoversWholeMonth`).
 */
export function lastChileBankDayOfMonth(periodMonth: string): string {
  let day = monthEndUtcYmd(periodMonth);
  const isBankDay = (d: string) => isChileBusinessDay(d) && d.slice(5) !== "12-31";
  for (let i = 0; i < 14 && !isBankDay(day); i++) day = addDaysYmd(day, -1);
  if (!isBankDay(day)) throw new Error(`no Chile bank day at the end of ${periodMonth}`);
  return day;
}

/**
 * Whether the document's period covers the whole calendar month: it opens at a close before the
 * month (DESDE in an earlier month or on its 1st, or none printed: the monthly xlsx) and closes at
 * the month's close or later — HASTA none printed, in a later month, on or after the month's last
 * bank day (`lastChileBankDayOfMonth`), or the day the next month's cartola on file opens at
 * (`nextMonthDesde`: its DESDE, the bank's own statement of this month's close). A DESDE inside
 * the month (the boundary slice of a straddling cuenta vista document) or a HASTA before the
 * month's close is a document that covers part of the month.
 */
export function cartolaCoversWholeMonth(p: CartolaMonthPeriod, nextMonthDesde: string | null = null): boolean {
  const opensBefore = p.period_from == null || p.period_from <= `${p.period_month}-01`;
  const to = p.period_to;
  const closesAtEnd =
    to == null || to > monthEndUtcYmd(p.period_month) || to === nextMonthDesde || to >= lastChileBankDayOfMonth(p.period_month);
  return opensBefore && closesAtEnd;
}
