/**
 * A total printed beside its parts, in any display unit: the total rounded once to the unit's
 * smallest coin, and the rounding leftover spread over the parts so that Σ parts == total exactly
 * at coin precision (largest-remainder apportionment). Independent per-part rounding gives
 * neither: Σ round(part) drifts from round(Σ part) by up to half a coin per part.
 *
 * Used where a payload builder serves a level with its parts (the headline's buckets, the value
 * map's frames and tiles). Never on a chart point (a node's value is exact, `nodeValue.ts`) and
 * never on a P/L input.
 */
import { currencyMinorDigits } from "./displayUnits.js";

export type CoinApportionment = {
  /** The total at coin precision; null when no part has a value and no total was given. */
  total: number | null;
  /** Index-aligned with the input: each part at coin precision, a null part still null. */
  parts: (number | null)[];
};

/** A value in coins; a value within float noise of a whole coin is that coin. */
function inCoins(value: number, coinsPerUnit: number): number {
  const x = value * coinsPerUnit;
  const whole = Math.round(x);
  return Math.abs(x - whole) < 1e-7 ? whole : x;
}

/**
 * `parts` (unrounded, in `unit`) at coin precision, adding up exactly to the total.
 *
 * - Without `total`: the total is Σ parts rounded once to the coin.
 * - With `total` (a coin amount already fixed one level up, e.g. a frame's share of its parent):
 *   the parts are made to add up to it. It must be the parts' sum rounded either way — a total
 *   further than that from the sum is not this set of parts, and throws.
 *
 * Every part is floored to the coin, then the coins left over go one each to the largest
 * fractional remainders (ties: input order). A null part (absent) stays null and takes no share.
 */
export function apportionToCoin(
  parts: readonly (number | null)[],
  unit: string,
  opts: { total?: number } = {}
): CoinApportionment {
  const coinsPerUnit = 10 ** currencyMinorDigits(unit);
  const out: (number | null)[] = parts.map(() => null);
  const present: { index: number; floor: number; frac: number }[] = [];
  let sum = 0;
  parts.forEach((v, index) => {
    if (v == null) return;
    if (!Number.isFinite(v)) throw new Error(`apportionToCoin: part ${index} is not a finite number`);
    const coins = inCoins(v, coinsPerUnit);
    const floor = Math.floor(coins);
    present.push({ index, floor, frac: coins - floor });
    sum += coins;
  });
  if (present.length === 0) {
    if (opts.total !== undefined && inCoins(opts.total, coinsPerUnit) !== 0) {
      throw new Error(`apportionToCoin: a total of ${opts.total} ${unit} with no part to carry it`);
    }
    return { total: opts.total ?? null, parts: out };
  }
  let totalCoins: number;
  if (opts.total === undefined) {
    totalCoins = Math.round(sum);
  } else {
    totalCoins = inCoins(opts.total, coinsPerUnit);
    if (!Number.isInteger(totalCoins)) {
      throw new Error(`apportionToCoin: the total ${opts.total} is not a whole number of ${unit} coins`);
    }
  }
  let left = totalCoins - present.reduce((s, p) => s + p.floor, 0);
  if (left < 0 || left > present.length) {
    throw new Error(
      `apportionToCoin: the parts add up to ${sum / coinsPerUnit} ${unit}, which does not round to the total ${totalCoins / coinsPerUnit}`
    );
  }
  // Stable sort: equal remainders keep input order.
  const byRemainder = [...present].sort((a, b) => b.frac - a.frac);
  for (const p of byRemainder) {
    out[p.index] = (p.floor + (left > 0 ? 1 : 0)) / coinsPerUnit;
    if (left > 0) left -= 1;
  }
  return { total: totalCoins / coinsPerUnit, parts: out };
}
