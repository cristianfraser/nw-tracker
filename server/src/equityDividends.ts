import { db } from "./db.js";
import { equityQuoteCurrency } from "./equityQuote.js";
import type { YahooDividend } from "./equityYahooEod.js";
import { dividendDiffersOnlyBySplits, equitySplitFactorAfter } from "./equitySplits.js";

/**
 * `equity_dividends` (migration 207): cash dividends per share by ex-date, in the ticker's quote
 * currency — what a total-return benchmark reinvests. Write-once like `fx_daily`: a fetch only
 * fills ex-dates never stored, and one that disagrees with a stored amount throws (Yahoo
 * restating a dividend is something to look at, not to absorb).
 */

const AMOUNT_TOLERANCE = 1e-6;

const stmtNearestDividend = db.prepare(
  `SELECT amount FROM equity_dividends WHERE ticker = ? ORDER BY ABS(julianday(ex_date) - julianday(?)) LIMIT 1`
);

/**
 * A dividend not stored yet, in the table's split-adjusted terms. Dated before a recorded split,
 * it may come as paid (pre-split) or adjusted: the reading closer to the nearest stored dividend
 * wins; with none stored it is taken as adjusted, Yahoo's convention.
 */
function adjustedNewDividend(ticker: string, d: YahooDividend): number {
  const f = equitySplitFactorAfter(ticker, d.ex_date);
  if (f === 1) return d.amount;
  const near = stmtNearestDividend.get(ticker, d.ex_date) as { amount: number } | undefined;
  if (near == null) return d.amount;
  const dist = (x: number) => Math.abs(Math.log(x / near.amount));
  return dist(d.amount / f) < dist(d.amount) ? d.amount / f : d.amount;
}

export function insertEquityDividendsIfMissing(
  ticker: string,
  dividends: readonly YahooDividend[]
): { inserted: number } {
  // An index pays nothing, and its level has no currency to stamp a dividend with.
  if (dividends.length === 0) return { inserted: 0 };
  const currency = equityQuoteCurrency(ticker);
  const get = db.prepare(`SELECT amount FROM equity_dividends WHERE ticker = ? AND ex_date = ?`);
  const ins = db.prepare(
    `INSERT INTO equity_dividends (ticker, ex_date, amount, currency) VALUES (?, ?, ?, ?)`
  );
  let inserted = 0;
  db.transaction(() => {
    for (const d of dividends) {
      const stored = get.get(ticker, d.ex_date) as { amount: number } | undefined;
      if (stored) {
        // A source that has not processed a later split still states the pre-split amount.
        if (
          Math.abs(stored.amount - d.amount) > AMOUNT_TOLERANCE &&
          !dividendDiffersOnlyBySplits(ticker, d.ex_date, stored.amount, d.amount)
        ) {
          throw new Error(
            `${ticker} dividend ${d.ex_date}: stored ${stored.amount}, Yahoo now says ${d.amount}`
          );
        }
        continue;
      }
      ins.run(ticker, d.ex_date, adjustedNewDividend(ticker, d), currency);
      inserted += 1;
    }
  })();
  return { inserted };
}
