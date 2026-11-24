/**
 * The position of a stock with no shares (`equityBrokeragePositionMeta`) is answered from the
 * shares: no units, no mark, and no live quote read, on two dates at several instants.
 */
import { describe, expect, it } from "vitest";
import { equityBrokeragePositionMeta } from "./accountPosition.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  PARITY_INSTANTS,
  holdingFixtures,
  observeLiveReads,
  storedStockTicker,
} from "./test/holdingParityFixtures.js";

const fixtures = holdingFixtures();

describe("the position of a stock with no shares reads no price", () => {
  it("a sold-out stock has no units and no mark, and reads no quote", () => {
    const ticker = storedStockTicker("VHFU");
    const soldOut = fixtures.account("sold-out stock", "brokerage_acciones__%", ticker);
    fixtures.singleLeg(soldOut, "2024-03-01", 1000, 10, "stock_buy", "usd");
    fixtures.singleLeg(soldOut, "2025-03-01", 1200, -10, "stock_sell", "usd");

    for (const now of PARITY_INSTANTS) {
      for (const asOf of [chileCalendarTodayYmd(), "2025-06-30"]) {
        const read = observeLiveReads(() => equityBrokeragePositionMeta(soldOut, ticker, asOf, now));
        const label = `sold-out position on ${asOf} at ${now.toISOString()}`;
        expect(read.out, label).toMatchObject({ ticker, units: null });
        expect(read.out, label).not.toHaveProperty("mark_value_clp");
        expect(read.tickers, label).toEqual([]);
      }
    }
  });
});
