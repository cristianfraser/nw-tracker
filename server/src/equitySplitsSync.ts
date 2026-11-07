/**
 * Splits Yahoo lists on a chart it was asked for anyway (the live quote, the EOD bars), recorded
 * through {@link recordEquitySplit}: the same transaction re-frames the stored prices and writes
 * each holder's `stock_split` row, so the first post-split price is never valued against the old
 * share count. A split dated after Chile today waits for its ex-date.
 */
import { invalidateMarketDataAggregations } from "./cacheRegistry.js";
import { chileWallClockAt } from "./chileDate.js";
import type { YahooSplit } from "./equityYahooEod.js";
import { recordEquitySplit } from "./equitySplits.js";

/** Records every split in `splits` due by now; true when anything was written. Throws on a ratio that disagrees with a recorded one. */
export function recordYahooSplits(ticker: string, splits: readonly YahooSplit[], now: Date = new Date()): boolean {
  const today = chileWallClockAt(now).ymd;
  let wrote = false;
  for (const s of splits) {
    if (s.ex_date > today) continue;
    const out = recordEquitySplit({ ticker, ...s, source: "yahoo" }, now);
    if (out.status === "recorded" || out.ledger.some((r) => r.status === "written")) {
      wrote = true;
      console.log(
        `equity-splits: ${ticker} ${s.numerator}:${s.denominator} on ${s.ex_date} ${out.status} ` +
          `(${out.rescaled.closes} closes re-framed, ${out.ledger.filter((r) => r.status === "written").length} holder row(s))`
      );
    }
  }
  if (wrote) invalidateMarketDataAggregations("historical");
  return wrote;
}
