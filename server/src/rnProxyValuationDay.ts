import { chileCalendarAddDays } from "./chileDate.js";
import { observadoFrameFxForDay } from "./fxObservadoFrame.js";
import { isChileBusinessDay, isNyseTradingDay } from "./marketHolidays.js";
import { isBeforeNyseRegularOpen, nyseWallClock } from "./nyseSession.js";

/**
 * The days the Risky Norris proxy values on their own, shared by the account marks
 * (`riskyNorrisProxyMtm.ts`) and the watchlist chip (`compositeLiveStats`) so both describe the
 * same day.
 *
 * A Chile business day with no NYSE session (a US holiday: Thanksgiving, Juneteenth, July 4th,
 * Labor Day, …) is an fx-only day. Fintual still prints a cuota for it, at the last session's US
 * closes and that day's dólar observado, so the cuota moves by the fx alone (Thanksgiving
 * 2025-11-27: cuota −0,18 %, observado frame −0,19 %); the proxy values it the same way — the
 * basket at its last closes, the fx leg on the day itself.
 */
export function isFxOnlyProxyDay(ymd: string): boolean {
  return !isNyseTradingDay(ymd) && isChileBusinessDay(ymd);
}

/**
 * A day the proxy values on its own: an NYSE session, or an fx-only day
 * ({@link isFxOnlyProxyDay}). Every other day (a weekend, a day both markets close) reflects the
 * one before it.
 */
export function isProxyValuationDay(ymd: string): boolean {
  return isNyseTradingDay(ymd) || isFxOnlyProxyDay(ymd);
}

/** The proxy valuation day strictly before `ymd` ({@link isProxyValuationDay}). */
export function priorProxyValuationDayYmd(ymd: string, maxSteps = 14): string | null {
  let cur = ymd;
  for (let i = 0; i < maxSteps; i++) {
    cur = chileCalendarAddDays(cur, -1);
    if (isProxyValuationDay(cur)) return cur;
  }
  return null;
}

/**
 * The proxy valuation day a calendar date's value reflects: the date itself when NYSE traded or
 * it is an fx-only day, else the one before (Friday's for a weekend day).
 */
export function proxyValuationDayOnOrBefore(ymd: string): string | null {
  return isProxyValuationDay(ymd) ? ymd : priorProxyValuationDayYmd(ymd);
}

/**
 * The valuation day the proxy is on right now, framed on the New York day: the current session
 * once it has opened; the current fx-only day once its own fx exists (the first prints of its
 * interbank window, 09:00 Chile — before that the frame only carries an earlier day's fx, so the
 * day has nothing of its own and the proxy would show nothing but its tracking error against
 * the previous cuota); otherwise the previous valuation day (yesterday's session, Friday's on a
 * weekend, the US holiday before a session's open).
 */
export function heldProxyValuationDayYmd(now: Date): string | null {
  const ny = nyseWallClock(now).ymd;
  if (isNyseTradingDay(ny)) return isBeforeNyseRegularOpen(now) ? priorProxyValuationDayYmd(ny) : ny;
  if (isFxOnlyProxyDay(ny) && observadoFrameFxForDay(ny, now).source === "carry") {
    return priorProxyValuationDayYmd(ny);
  }
  return proxyValuationDayOnOrBefore(ny);
}
