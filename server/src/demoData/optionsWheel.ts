/**
 * The demo person's options wheel at his US broker (docs/demo-app-features-plan.md §5, wave O2): a
 * quarterly cash-secured put, or a covered call while he holds the assigned shares. Pure rules
 * only — what to sell, when it expires, what it pays and how it ends; the simulator books the
 * rows (`simulate.ts`) and the generator writes them through the app's option model.
 *
 * Every number here is a STORY assumption, not a pricing model: the premium is a fixed share of
 * the strike per day to expiry, the strike a fixed distance out of the money, and the outcome is
 * decided by the underlying's close on the expiry day — whatever the closes produce is the story
 * (no assignment is ever forced, none is ever prevented).
 */
import { addDays, addMonths, monthOf, ymd, type Month, type OptionsWheel, type Ymd } from "./person.js";

export type WheelRight = "C" | "P";

/** The third Friday of a month (the standard monthly option expiry). */
export function thirdFriday(month: Month): Ymd {
  const first = ymd(month, 1);
  const dow = new Date(`${first}T00:00:00Z`).getUTCDay(); // 0 Sunday … 5 Friday
  const firstFriday = 1 + ((5 - dow + 7) % 7);
  return ymd(month, firstFriday + 14);
}

const daysBetween = (a: Ymd, b: Ymd) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;

/**
 * The expiry for a contract sold on `sellDay`: the third Friday (of the target's month or its
 * neighbours) nearest to `targetDays` out — the earlier one on a tie — moved to the Thursday when
 * that Friday is not a trading day (Good Friday). The Thursday must trade.
 */
export function wheelExpiry(sellDay: Ymd, targetDays: number, isTradingDay: (d: Ymd) => boolean): Ymd {
  const target = addDays(sellDay, targetDays);
  const m = monthOf(target);
  const fridays = [addMonths(m, -1), m, addMonths(m, 1)].map(thirdFriday).filter((f) => f > sellDay);
  const best = fridays.reduce((a, b) => (Math.abs(daysBetween(target, b)) < Math.abs(daysBetween(target, a)) ? b : a));
  if (isTradingDay(best)) return best;
  const thursday = addDays(best, -1);
  if (!isTradingDay(thursday)) throw new Error(`demo wheel: neither ${best} nor ${thursday} is a trading day`);
  return thursday;
}

/** The sale day of a trade month: the configured day, or the next trading day. */
export function wheelTradeDayOf(month: Month, tradeDay: number, isTradingDay: (d: Ymd) => boolean): Ymd {
  let d = ymd(month, tradeDay);
  for (let i = 0; i < 10 && !isTradingDay(d); i++) d = addDays(d, 1);
  if (!isTradingDay(d)) throw new Error(`demo wheel: no trading day near ${month}-${tradeDay}`);
  return d;
}

/** Whether `month` is a sale month of the wheel (from its first month, every `everyMonths`). */
export function isWheelSaleMonth(w: Pick<OptionsWheel, "from" | "everyMonths">, month: Month): boolean {
  if (month < w.from) return false;
  const [fy, fm] = w.from.split("-").map(Number) as [number, number];
  const [y, m] = month.split("-").map(Number) as [number, number];
  return ((y - fy) * 12 + (m - fm)) % w.everyMonths === 0;
}

/** A put while he holds no shares at the broker to deliver, a covered call once he does. */
export function wheelRight(sharesHeldAtBroker: number, multiplier = 100): WheelRight {
  return sharesHeldAtBroker >= multiplier ? "C" : "P";
}

/** The strike: out of the money by `otmPct`, rounded away from the money to the step (never into it). */
export function wheelStrike(close: number, right: WheelRight, otmPct: number, step: number): number {
  const raw = close * (right === "P" ? 1 - otmPct / 100 : 1 + otmPct / 100);
  const k = right === "P" ? Math.floor(raw / step + 1e-9) * step : Math.ceil(raw / step - 1e-9) * step;
  return Math.round(k * 1000) / 1000;
}

/** Premium per share (USD, to the cent): a fixed share of the strike per day to expiry. */
export function wheelPremiumPerShare(strike: number, daysToExpiry: number, pctOfStrikePerDay: number): number {
  return Math.max(0.01, Math.round(strike * (pctOfStrikePerDay / 100) * daysToExpiry * 100) / 100);
}

/** At the expiry: a put is assigned when the close is below the strike, a call when it is above. */
export function wheelOutcome(right: WheelRight, strike: number, closeOnExpiry: number): "assigned" | "expired" {
  return (right === "P" ? closeOnExpiry < strike : closeOnExpiry > strike) ? "assigned" : "expired";
}

/**
 * The underlying: the largest of the candidates whose `multiplier` shares cost no more than the
 * collateral he keeps at the broker (the SGOV reserve counts), by the closes on the first trade
 * day. Throws when none fits.
 */
export function pickWheelUnderlying(
  candidates: readonly { ticker: string; close: number }[],
  collateralUsd: number,
  multiplier = 100
): { ticker: string; close: number } {
  const fits = candidates.filter((c) => c.close * multiplier <= collateralUsd);
  if (fits.length === 0) throw new Error(`demo wheel: no candidate's ${multiplier} shares cost US$${collateralUsd} or less`);
  return fits.reduce((a, b) => (b.close > a.close ? b : a));
}

export type WheelTrade = { right: WheelRight; strike: number; expiry: Ymd; premiumPerShare: number };

/** One sale: what to write on `day` given the close and the shares held at the broker. */
export function planWheelTrade(
  w: OptionsWheel,
  day: Ymd,
  close: number,
  sharesHeldAtBroker: number,
  isTradingDay: (d: Ymd) => boolean
): WheelTrade {
  const right = wheelRight(sharesHeldAtBroker);
  const strike = wheelStrike(close, right, w.otmPct, w.strikeStep);
  const expiry = wheelExpiry(day, w.targetDays, isTradingDay);
  return { right, strike, expiry, premiumPerShare: wheelPremiumPerShare(strike, daysBetween(day, expiry), w.premiumPctOfStrikePerDay) };
}
