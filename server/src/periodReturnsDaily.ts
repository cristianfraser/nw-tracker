import { monthEndUtcYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { addMonths, annualize, monthSpanInclusive, type PeriodReturnsPayload } from "./periodReturns.js";
import { chainDailyPct } from "./periodPctDailyChain.js";

/**
 * The Rentabilidad month windows (MTD, YTD, 1A, 3A, 5A, TOTAL) chained from DAILY returns: each
 * day's flow-adjusted `pct` of the account's or group's own daily series, from the month-end
 * before the window's first month through today. Chaining months instead treats a month's
 * deposits as if they arrived on its first day, which misstates a month with large mid-month
 * flows (Acciones: 7,6% monthly vs 12,6% daily over its history). A day without a return (nothing
 * held) is flat; a window with none at all is null. The pesos (`nominal_pl`) and the window
 * bounds stay the monthly ones. The 1D/1W cells (`window_start_date`, from
 * `withShortHorizonCells`, so apply this after it) compound the days after their anchor date
 * too: 1D is the last day's return, 1W the last seven compounded. Annualized on the same
 * windows as before (more than 12 calendar months). Pure; one rule with `periodPctDailyChain.ts`.
 */
export function withDailyChainedReturns(
  payload: PeriodReturnsPayload | null,
  points: readonly { as_of_date: string; pct: number | null }[],
  todayYmd: string = chileCalendarTodayYmd()
): PeriodReturnsPayload | null {
  if (payload == null) return null;
  const anchorMk = todayYmd.slice(0, 7);
  return {
    ...payload,
    periods: payload.periods.map((cell) => {
      if (cell.window_start_date) {
        return { ...cell, pct: chainDailyPct(points, cell.window_start_date, todayYmd) };
      }
      if (!cell.window_start_month) return cell;
      const startYmd = monthEndUtcYmd(addMonths(cell.window_start_month, -1));
      const pct = chainDailyPct(points, startYmd, todayYmd);
      return {
        ...cell,
        pct,
        annualized_pct: annualize(pct, monthSpanInclusive(cell.window_start_month, anchorMk)),
      };
    }),
  };
}
