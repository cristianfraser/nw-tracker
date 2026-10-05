import { db } from "./db.js";
import { equityQuoteCurrency } from "./equityQuote.js";
import type { YahooDividend } from "./equityYahooEod.js";

/**
 * `equity_dividends` (migration 207): cash dividends per share by ex-date, in the ticker's quote
 * currency — what a total-return benchmark reinvests. Write-once like `fx_daily`: a fetch only
 * fills ex-dates never stored, and one that disagrees with a stored amount throws (Yahoo
 * restating a dividend is something to look at, not to absorb).
 */

const AMOUNT_TOLERANCE = 1e-6;

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
        if (Math.abs(stored.amount - d.amount) > AMOUNT_TOLERANCE) {
          throw new Error(
            `${ticker} dividend ${d.ex_date}: stored ${stored.amount}, Yahoo now says ${d.amount}`
          );
        }
        continue;
      }
      ins.run(ticker, d.ex_date, d.amount, currency);
      inserted += 1;
    }
  })();
  return { inserted };
}
