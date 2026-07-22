import { equityMarketKind } from "./equityQuote.js";
import { isChileBusinessDay, isNyseTradingDay } from "./marketHolidays.js";

/**
 * displayPL for per-instrument day changes (marquee, watchlist 1D): the underlying delta is
 * the real series change, but on a day the instrument's market is closed the displayed day
 * change is a hard 0 — a Saturday marquee shows SPY 0,00%, not Friday's session move.
 *
 * Tickers only, by design (2026-07-21): account and bucket money surfaces (Rentabilidad
 * strip, dashboard day cells, daily table) always show the real calendar-day PL — marks are
 * flat on closed days, so those land at 0 naturally and any residue (e.g. fx drift on a US
 * holiday) is real CLP P/L.
 */
export type TickerDayCalendar = "nyse" | "chile" | "weekday" | "always";

/** Which calendar governs an equity/crypto ticker's day-change display. */
export function equityTickerDayCalendar(ticker: string): TickerDayCalendar {
  const kind = equityMarketKind(ticker);
  if (kind === "crypto24") return "always";
  return kind === "santiago" ? "chile" : "nyse";
}

function isWeekendYmd(ymd: string): boolean {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  const dow = new Date(t).getUTCDay();
  return dow === 0 || dow === 6;
}

export function tickerMarketOpenOnYmd(calendar: TickerDayCalendar, ymd: string): boolean {
  switch (calendar) {
    case "always":
      return true;
    case "weekday":
      return !isWeekendYmd(ymd);
    case "chile":
      return isChileBusinessDay(ymd);
    case "nyse":
      return isNyseTradingDay(ymd);
  }
}

/** The display day change: real when the instrument's market is open today, else hard 0. */
export function displayDayPct(
  calendar: TickerDayCalendar,
  todayYmd: string,
  realDayPct: number | null
): number | null {
  if (realDayPct == null) return null;
  return tickerMarketOpenOnYmd(calendar, todayYmd) ? realDayPct : 0;
}
