/**
 * Today's mark of a coin account holding no coins (`computeCryptoMtmClpDisplaySync`) is
 * answered from the coins: same mark as the priced rule it replaced, for every crypto account
 * at several instants, and no live quote read for an empty account.
 */
import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  accountUsesCryptoMtm,
  computeCryptoMtmClp,
  computeCryptoMtmClpCachedLive,
  computeCryptoMtmClpDisplaySync,
  cryptoEquityTickerForAccount,
} from "./cryptoValuation.js";
import { cryptoDisplaySessionYmd, equitySessionYmdForTicker, shouldUseLiveEquityQuote } from "./equityQuote.js";
import { PARITY_INSTANTS, allAccountIds, holdingFixtures, observeLiveReads } from "./test/holdingParityFixtures.js";

const fixtures = holdingFixtures();

/** The rule as it was: live quote first, the coins inside each pricing. */
function priorCryptoDisplaySync(accountId: number, now: Date): { value_clp: number; as_of_date: string } | null {
  const ticker = cryptoEquityTickerForAccount(accountId);
  if (!ticker || !accountUsesCryptoMtm(accountId)) return null;
  const session = equitySessionYmdForTicker(ticker, now);
  if (shouldUseLiveEquityQuote(ticker, session, now)) {
    const cached = computeCryptoMtmClpCachedLive(accountId, now);
    if (cached != null && Number.isFinite(cached)) return { value_clp: cached, as_of_date: session };
    const fromSession = computeCryptoMtmClp(accountId, session, null, now);
    if (fromSession != null && Number.isFinite(fromSession)) return { value_clp: fromSession, as_of_date: session };
  }
  const displayYmd = cryptoDisplaySessionYmd(ticker, now);
  const fromDisplay = computeCryptoMtmClp(accountId, displayYmd, null, now);
  if (fromDisplay != null && Number.isFinite(fromDisplay)) return { value_clp: fromDisplay, as_of_date: displayYmd };
  const md = (db.prepare(`SELECT max(trade_date) AS md FROM equity_daily WHERE ticker = ?`).get(ticker) as
    | { md: string | null }
    | undefined)?.md;
  if (!md) return null;
  const c = computeCryptoMtmClp(accountId, md, null, now);
  if (c == null || !Number.isFinite(c)) return null;
  return { value_clp: c, as_of_date: md };
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
    expect(observeLiveReads(() => priorCryptoDisplaySync(soldOut, now)).tickers).toEqual(["BTC-USD"]);
  });
});
