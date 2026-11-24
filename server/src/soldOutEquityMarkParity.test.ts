/**
 * Today's mark of a stock with no shares is answered from the shares (`equityTodayClp`):
 * 0 at every instant, and no live quote read for an empty position.
 */
import { describe, expect, it } from "vitest";
import { equityTodayClp } from "./test/todayClpMarks.js";
import {
  PARITY_INSTANTS,
  holdingFixtures,
  observeLiveReads,
  storedStockTicker,
} from "./test/holdingParityFixtures.js";

const fixtures = holdingFixtures();

describe("today's mark of a stock with no shares reads no price", () => {
  it("marks a sold-out stock at 0 and reads no quote", () => {
    const soldOut = fixtures.account("sold-out stock", "brokerage_acciones__%", storedStockTicker("VHFU"));
    fixtures.singleLeg(soldOut, "2024-03-01", 1000, 10, "stock_buy", "usd");
    fixtures.singleLeg(soldOut, "2025-03-01", 1200, -10, "stock_sell", "usd");

    for (const now of PARITY_INSTANTS) {
      const read = observeLiveReads(() => equityTodayClp(soldOut, now));
      expect(read.out, `at ${now.toISOString()}`).toMatchObject({ value_clp: 0 });
      expect(read.tickers, `at ${now.toISOString()}`).toEqual([]);
    }
  });
});
