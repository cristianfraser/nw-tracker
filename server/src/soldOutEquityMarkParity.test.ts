/**
 * Today's mark of a stock with no shares is answered from the shares (`computeEquityMtmClpDisplaySync`):
 * same mark as the priced rule it replaced, for every stock account at several instants, and no
 * live quote read for an empty position.
 */
import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  accountUsesEquityMtm,
  computeEquityMtmClpDisplaySync,
  equityShareUnitsThroughYmd,
  firstEquityShareActivityYmd,
} from "./brokerageEquityMtm.js";
import { requireEquityTicker } from "./accountEquityTicker.js";
import {
  equityCloseEod,
  equityDisplaySessionYmd,
  equityHeldSessionQuote,
  equityQuoteCurrency,
  equitySessionYmdForTicker,
  getLiveEquityQuoteFromDb,
  shouldUseLiveEquityQuote,
} from "./equityQuote.js";
import { chileWallClockAt } from "./chileDate.js";
import { convertValue } from "./valueConvert.js";
import {
  PARITY_INSTANTS,
  allAccountIds,
  holdingFixtures,
  observeLiveReads,
  storedStockTicker,
} from "./test/holdingParityFixtures.js";

const fixtures = holdingFixtures();

/**
 * The rule as it was, every pricing first and the shares last — in today's frame: the price
 * chosen (live in session, the session bar, the held print, the display session's bar, the
 * newest bar) × the shares held today, converted once at today's sell rate.
 */
function priorEquityDisplaySync(accountId: number, now: Date): { value_clp: number; as_of_date: string } | null {
  if (!accountUsesEquityMtm(accountId)) return null;
  const ticker = requireEquityTicker(accountId);
  const today = chileWallClockAt(now).ymd;
  const units = equityShareUnitsThroughYmd(accountId, today);
  const session = equitySessionYmdForTicker(ticker, now);
  const displayYmd = equityDisplaySessionYmd(ticker, now);
  const priced = (price: number | null | undefined, asOf: string) => {
    if (price == null || !(price > 0) || !(units > 0)) return null;
    const clp = convertValue(units * price, equityQuoteCurrency(ticker), "clp", today, "asset", now);
    return clp != null && clp > 0 ? { value_clp: clp, as_of_date: asOf } : null;
  };
  let out: { value_clp: number; as_of_date: string } | null = null;
  if (shouldUseLiveEquityQuote(ticker, session, now)) {
    out = priced(getLiveEquityQuoteFromDb(ticker)?.price, session) ?? priced(equityCloseEod(ticker, session), session);
  }
  if (!out) out = priced(equityHeldSessionQuote(ticker, now)?.price, session);
  if (!out) out = priced(equityCloseEod(ticker, displayYmd), displayYmd);
  if (!out) {
    const md = (db.prepare(`SELECT max(trade_date) AS md FROM equity_daily WHERE ticker = ?`).get(ticker) as
      | { md: string | null }
      | undefined)?.md;
    if (md) out = priced(equityCloseEod(ticker, md), md);
  }
  if (out) return out;
  if (firstEquityShareActivityYmd(accountId) != null && equityShareUnitsThroughYmd(accountId, displayYmd) <= 0) {
    return { value_clp: 0, as_of_date: displayYmd };
  }
  return null;
}

describe("today's mark of a stock with no shares reads no price", () => {
  it("matches the priced rule for every stock account, and reads no quote when sold out", () => {
    const soldOut = fixtures.account("sold-out stock", "brokerage_acciones__%", storedStockTicker("VHFU"));
    fixtures.singleLeg(soldOut, "2024-03-01", 1000, 10, "stock_buy", "usd");
    fixtures.singleLeg(soldOut, "2025-03-01", 1200, -10, "stock_sell", "usd");
    const held = fixtures.account("held stock", "brokerage_acciones__%", "VHFU2");
    fixtures.singleLeg(held, "2024-03-01", 1000, 4, "stock_buy", "usd");

    let compared = 0;
    for (const id of allAccountIds()) {
      if (!accountUsesEquityMtm(id)) continue;
      for (const now of PARITY_INSTANTS) {
        const before = observeLiveReads(() => priorEquityDisplaySync(id, now));
        const after = observeLiveReads(() => computeEquityMtmClpDisplaySync(id, now));
        expect(after.out, `stock ${id} at ${now.toISOString()}`).toEqual(before.out);
        if (after.out != null && typeof after.out === "object" && after.out.value_clp === 0) {
          expect(after.tickers, `sold-out stock ${id} reads no quote`).toEqual([]);
        }
        compared++;
      }
    }
    expect(compared).toBeGreaterThanOrEqual(2 * PARITY_INSTANTS.length);
    const now = PARITY_INSTANTS[1]!;
    expect(observeLiveReads(() => computeEquityMtmClpDisplaySync(soldOut, now)).out).toMatchObject({ value_clp: 0 });
    expect(observeLiveReads(() => priorEquityDisplaySync(soldOut, now)).tickers).not.toEqual([]);
  });
});
