/**
 * Today's mark of a coin account holding no coins (`cryptoTodayClp`) is answered from the
 * coins: 0 at every instant, and no live quote read for an empty account.
 */
import { describe, expect, it } from "vitest";
import { cryptoTodayClp } from "./test/todayClpMarks.js";
import { PARITY_INSTANTS, holdingFixtures, observeLiveReads } from "./test/holdingParityFixtures.js";

const fixtures = holdingFixtures();

describe("today's mark of a coin account with no coins reads no price", () => {
  it("marks a sold-out coin account at 0 and reads no quote", () => {
    const soldOut = fixtures.account("sold-out coin", "brokerage_crypto__bitcoin", "BTC-USD");
    fixtures.singleLeg(soldOut, "2024-03-01", 500_000, 0.01, null);
    fixtures.singleLeg(soldOut, "2025-03-01", -600_000, -0.01, null);

    for (const now of PARITY_INSTANTS) {
      const read = observeLiveReads(() => cryptoTodayClp(soldOut, now));
      expect(read.out, `at ${now.toISOString()}`).toMatchObject({ value_clp: 0 });
      expect(read.tickers, `at ${now.toISOString()}`).toEqual([]);
    }
  });
});
