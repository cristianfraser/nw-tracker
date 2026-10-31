/**
 * Today's mark of a stock with no shares is answered from the shares (`computeEquityMtmClpDisplaySync`):
 * same mark as the priced rule it replaced, for every stock account at several instants, and no
 * live quote read for an empty position.
 */
import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  accountUsesEquityMtm,
  computeEquityMtmClp,
  computeEquityMtmClpCachedLive,
  computeEquityMtmClpDisplaySync,
  equityShareUnitsThroughYmd,
  firstEquityShareActivityYmd,
} from "./brokerageEquityMtm.js";
import { requireEquityTicker } from "./accountEquityTicker.js";
import {
  equityDisplaySessionYmd,
  equityHeldSessionQuote,
  equitySessionYmdForTicker,
  shouldUseLiveEquityQuote,
} from "./equityQuote.js";
import {
  PARITY_INSTANTS,
  allAccountIds,
  holdingFixtures,
  observeLiveReads,
  storedStockTicker,
} from "./test/holdingParityFixtures.js";

const fixtures = holdingFixtures();

/** The rule as it was: every pricing first, the shares last. */
function priorEquityDisplaySync(accountId: number, now: Date): { value_clp: number; as_of_date: string } | null {
  if (!accountUsesEquityMtm(accountId)) return null;
  const ticker = requireEquityTicker(accountId);
  const session = equitySessionYmdForTicker(ticker, now);
  if (shouldUseLiveEquityQuote(ticker, session, now)) {
    const cached = computeEquityMtmClpCachedLive(accountId, now);
    if (cached != null && Number.isFinite(cached) && cached > 0) return { value_clp: cached, as_of_date: session };
    const fromSession = computeEquityMtmClp(accountId, session, null, now);
    if (fromSession != null && Number.isFinite(fromSession) && fromSession > 0) {
      return { value_clp: fromSession, as_of_date: session };
    }
  }
  const held = equityHeldSessionQuote(ticker, now);
  if (held) {
    const fromHeld = computeEquityMtmClp(accountId, session, held.price, now);
    if (fromHeld != null && Number.isFinite(fromHeld) && fromHeld > 0) return { value_clp: fromHeld, as_of_date: session };
  }
  const displayYmd = equityDisplaySessionYmd(ticker, now);
  const fromDisplay = computeEquityMtmClp(accountId, displayYmd, null, now);
  if (fromDisplay != null && Number.isFinite(fromDisplay) && fromDisplay > 0) {
    return { value_clp: fromDisplay, as_of_date: displayYmd };
  }
  const md = (db.prepare(`SELECT max(trade_date) AS md FROM equity_daily WHERE ticker = ?`).get(ticker) as
    | { md: string | null }
    | undefined)?.md;
  if (md) {
    const fromEod = computeEquityMtmClp(accountId, md);
    if (fromEod != null && Number.isFinite(fromEod) && fromEod > 0) return { value_clp: fromEod, as_of_date: md };
  }
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
