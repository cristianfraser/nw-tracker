/**
 * VALUES converted between currencies (`docs/holdings-currency-plan.md`): a quantity of what an
 * account holds turned into a display unit once, at the side of the spread that closes it
 * (`rates.ts`). A day before Chile today reads the stored rate, which is kept per (pair, side,
 * day) in the history tier (`cacheRegistry.ts`; every rate table is a mark input, so a write
 * drops the tier); today and later read `convertCurrency` directly (the live rate).
 *
 * Flows never come here: they convert per event at their own day's flow rate (`convertFlow`).
 */
import { historyTierMemo } from "./cacheRegistry.js";
import { chileCalendarTodayYmd, chileWallClockAt } from "./chileDate.js";
import { convertCurrency, type ConvertSide, type CurrencyCode, type TsUnit } from "./rates.js";

export type ValueSide = Exclude<ConvertSide, "mid">;

/** The stored rate on a past day: `to` per one `from`, null without one on file. */
function pastRate(from: CurrencyCode, to: CurrencyCode, ymd: string, side: ValueSide): number | null {
  const memo = historyTierMemo<string, number | null>(`value_rate|${from}|${to}|${side}`);
  let r = memo.get(ymd);
  if (r === undefined) {
    r = convertCurrency(1, from, to, ymd, { side });
    memo.set(ymd, r);
  }
  return r;
}

/**
 * `qty` of `from` in `to` on `ymd` at `side` — a value, never a flow. Null when a rate the walk
 * needs is not on file.
 */
export function convertValue(
  qty: number,
  from: CurrencyCode,
  to: CurrencyCode,
  ymd: string,
  side: ValueSide,
  now?: Date
): number | null {
  if (from === to || qty === 0) return qty;
  const today = now ? chileWallClockAt(now).ymd : chileCalendarTodayYmd();
  if (now === undefined && ymd < today) {
    const r = pastRate(from, to, ymd, side);
    if (r == null) return null;
    const out = qty * r;
    return Number.isFinite(out) ? out : null;
  }
  return convertCurrency(qty, from, to, ymd, { side, now });
}

/**
 * A per-day rate lookup for one (from, to, side) over many past days (the daily series' grids):
 * the same memo as {@link convertValue}. Throws for today or later, which read the live rate.
 */
export function pastValueRateLookup(
  from: CurrencyCode,
  to: CurrencyCode,
  side: ValueSide
): (ymd: string) => number | null {
  if (from === to) return () => 1;
  const today = chileCalendarTodayYmd();
  const memo = historyTierMemo<string, number | null>(`value_rate|${from}|${to}|${side}`);
  return (ymd) => {
    if (ymd >= today) throw new Error(`pastValueRateLookup: ${ymd} is not before Chile today`);
    let r = memo.get(ymd);
    if (r === undefined) {
      r = convertCurrency(1, from, to, ymd, { side });
      memo.set(ymd, r);
    }
    return r;
  };
}

/**
 * A VALUE in pesos at `ymd`, in `unit`, converted once at its side: the stored rate on a past
 * day, today's rate (live while the fx day is open) today and on a later date (the current
 * month's month-end point). For an amount that is not one account's value (a card total netted
 * from cash, a reference line); an account's value goes through `accountValueAt` (or, given its
 * pesos, `accountValueInUnitFromClp`). Null when no rate is on file.
 */
export function clpToUnitAt(
  clp: number,
  ymd: string,
  unit: TsUnit,
  opts?: { now?: Date; side?: ValueSide }
): number | null {
  if (unit === "clp") return clp;
  const out = convertValue(clp, "clp", unit, ymd, opts?.side ?? "asset", opts?.now);
  return out != null && Number.isFinite(out) ? out : null;
}
