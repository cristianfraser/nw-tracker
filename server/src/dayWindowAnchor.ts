import { equityTickerForAccount } from "./accountEquityTicker.js";
import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import { chileCalendarAddDays } from "./chileDate.js";
import { accountUsesCryptoMtm } from "./cryptoValuation.js";
import { equityQuoteCurrency } from "./equityQuote.js";
import { priorChileBusinessDayYmd, priorNyseSessionYmd } from "./marketHolidays.js";

/**
 * Day-window anchors: each account's "vs last close" compares against the last close of its
 * OWN calendar — UF-marked (property/mortgage) and crypto reprice every calendar day
 * (yesterday); USD-quoted stocks close per NYSE session; `.SN` stocks (Bolsa de Santiago),
 * retirement cuotas/fondos, and efectivo balances follow Chilean business days.
 */
export type DayWindowAnchors = {
  /** Yesterday (Chile calendar) — UF-marked assets and crypto. */
  calendar: string;
  /** Prior Chilean business day — retirement, efectivo, `.SN` stocks, stored-mark accounts. */
  chile: string | null;
  /** Prior NYSE session — USD-quoted stocks ("vs last workday", weekend drift included). */
  nyse: string | null;
};

export function dayWindowAnchorsForToday(todayYmd: string): DayWindowAnchors {
  return {
    calendar: chileCalendarAddDays(todayYmd, -1),
    chile: priorChileBusinessDayYmd(todayYmd),
    nyse: priorNyseSessionYmd(todayYmd),
  };
}

/** Resolve one account's day anchor by its valuation calendar (see {@link DayWindowAnchors}). */
export function dayWindowAnchorForAccount(
  accountId: number,
  kindSlug: string,
  anchors: DayWindowAnchors
): string | null {
  if (kindSlug === "property" || kindSlug === "mortgage") return anchors.calendar;
  // CC owed moves on any calendar day (purchases/PAGOs land on their transaction date).
  if (kindSlug === "credit_card") return anchors.calendar;
  if (accountUsesCryptoMtm(accountId)) return anchors.calendar;
  if (accountUsesEquityMtm(accountId)) {
    const ticker = equityTickerForAccount(accountId);
    if (ticker && equityQuoteCurrency(ticker) === "usd") return anchors.nyse;
    return anchors.chile;
  }
  return anchors.chile;
}
