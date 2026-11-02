/**
 * Today's mark of a coin account holding no coins (`computeCryptoMtmClpDisplaySync`) is
 * answered from the coins: same mark as the priced rule it replaced, for every crypto account
 * at several instants, and no live quote read for an empty account.
 */
import { describe, expect, it } from "vitest";
import {
  accountUsesCryptoMtm,
  computeCryptoMtmClpDisplaySync,
  cryptoCoinCumulativeThroughDate,
  cryptoEquityTickerForAccount,
} from "./cryptoValuation.js";
import {
  equityCloseEod,
  equitySessionYmdForTicker,
  getLiveEquityQuoteFromDb,
  shouldUseLiveEquityQuote,
} from "./equityQuote.js";
import { chileWallClockAt } from "./chileDate.js";
import { convertValue } from "./valueConvert.js";
import { PARITY_INSTANTS, allAccountIds, holdingFixtures, observeLiveReads } from "./test/holdingParityFixtures.js";

const fixtures = holdingFixtures();

/**
 * The rule as it was, the coins inside each pricing — in today's frame: the live quote of the
 * UTC session, else the newest close on or before today, × the coins held today, converted
 * once at today's sell rate.
 */
function priorCryptoDisplaySync(accountId: number, now: Date): { value_clp: number; as_of_date: string } | null {
  const ticker = cryptoEquityTickerForAccount(accountId);
  if (!ticker || !accountUsesCryptoMtm(accountId)) return null;
  const today = chileWallClockAt(now).ymd;
  const units = cryptoCoinCumulativeThroughDate(accountId, today);
  const session = equitySessionYmdForTicker(ticker, now);
  // No coins: 0 on the session even with no price on file (the units decide, like a sold-out stock).
  if (!(units > 1e-12)) return { value_clp: 0, as_of_date: session };
  const priced = (price: number | null | undefined, asOf: string) => {
    if (price == null || !(price > 0)) return null;
    const usd = units > 1e-12 ? units * price : 0;
    const clp = convertValue(usd, "usd", "clp", today, "asset", now);
    return clp != null ? { value_clp: clp, as_of_date: usd === 0 ? session : asOf } : null;
  };
  let out: { value_clp: number; as_of_date: string } | null = null;
  if (shouldUseLiveEquityQuote(ticker, session, now)) out = priced(getLiveEquityQuoteFromDb(ticker)?.price, session);
  return out ?? priced(equityCloseEod(ticker, today), today);
}

describe("today's mark of a coin account with no coins reads no price", () => {
  it("matches the priced rule for every crypto account, and reads no quote when empty", () => {
    const soldOut = fixtures.account("sold-out coin", "brokerage_crypto__bitcoin", "BTC-USD");
    fixtures.singleLeg(soldOut, "2024-03-01", 500_000, 0.01, null);
    fixtures.singleLeg(soldOut, "2025-03-01", -600_000, -0.01, null);
    const held = fixtures.account("held coin", "brokerage_crypto__bitcoin", "BTC-USD");
    fixtures.singleLeg(held, "2024-03-01", 500_000, 0.02, null);

    let compared = 0;
    for (const id of allAccountIds()) {
      if (!accountUsesCryptoMtm(id)) continue;
      for (const now of PARITY_INSTANTS) {
        const before = observeLiveReads(() => priorCryptoDisplaySync(id, now));
        const after = observeLiveReads(() => computeCryptoMtmClpDisplaySync(id, now));
        expect(after.out, `coin ${id} at ${now.toISOString()}`).toEqual(before.out);
        if (after.out != null && typeof after.out === "object" && after.out.value_clp === 0) {
          expect(after.tickers, `empty coin account ${id} reads no quote`).toEqual([]);
        }
        compared++;
      }
    }
    expect(compared).toBeGreaterThanOrEqual(2 * PARITY_INSTANTS.length);
    const now = PARITY_INSTANTS[1]!;
    expect(observeLiveReads(() => computeCryptoMtmClpDisplaySync(soldOut, now)).out).toMatchObject({ value_clp: 0 });
  });
});
