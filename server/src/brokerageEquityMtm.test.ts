import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { nyseDisplaySessionYmd } from "./nyseSession.js";
import { clearLiveMarketQuotesForTest } from "./liveMarketQuotesDb.js";
import {
  computeEquityMtmClp,
  computeEquityMtmClpDisplaySync,
  computeLatestDisplayedEquityClp,
  equityTickerForAccount,
} from "./brokerageEquityMtm.js";
import { listAccountsForBucketSlug } from "./assetGroupTree.js";
import { NOTE_STOCKS_LEGACY } from "./brokerageAcciones.js";
import { BROKERAGE_SHARE_UNITS_FLOW_KINDS } from "./brokerageFlowMovement.js";

afterEach(() => {
  clearLiveMarketQuotesForTest();
});

function firstAccionesAccountWithTicker(): { account_id: number; ticker: string } | null {
  const rows = listAccountsForBucketSlug("brokerage", "acciones", NOTE_STOCKS_LEGACY);
  for (const r of rows) {
    const ticker = equityTickerForAccount(r.account_id);
    if (!ticker) continue;
    const hasUnits = db
      .prepare(
        `SELECT 1 FROM movements WHERE account_id = ? AND flow_kind IN (${BROKERAGE_SHARE_UNITS_FLOW_KINDS.map(() => "?").join(", ")}) AND COALESCE(units_delta, 0) != 0 LIMIT 1`
      )
      .get(r.account_id, ...BROKERAGE_SHARE_UNITS_FLOW_KINDS);
    if (hasUnits) return { account_id: r.account_id, ticker };
  }
  return null;
}

describe("equityTickerForAccount", () => {
  it("OILK account uses OILK not ILK", () => {
    const row = db
      .prepare(
        `SELECT id, equity_ticker FROM accounts WHERE notes = 'import:excel|key=oilk' LIMIT 1`
      )
      .get() as { id: number; equity_ticker: string | null } | undefined;
    if (!row) return;
    expect(row.equity_ticker).toBe("OILK");
    expect(equityTickerForAccount(row.id)).toBe("OILK");
  });

  it("reads SPY from accounts.equity_ticker", () => {
    const row = db
      .prepare(
        `SELECT id, equity_ticker FROM accounts WHERE notes = 'import:excel|key=spy' LIMIT 1`
      )
      .get() as { id: number; equity_ticker: string | null } | undefined;
    if (!row?.equity_ticker) return;
    expect(equityTickerForAccount(row.id)).toBe("SPY");
  });
});

describe("computeLatestDisplayedEquityClp", () => {
  it("does not throw when resolving fallback EOD date", () => {
    const acct = firstAccionesAccountWithTicker();
    if (!acct) return;
    expect(() => computeLatestDisplayedEquityClp(acct.account_id)).not.toThrow();
  });
});

describe("computeEquityMtmClpDisplaySync", () => {
  it("uses nyseDisplaySessionYmd after close", () => {
    const acct = firstAccionesAccountWithTicker();
    if (!acct) return;
    const afterClose = new Date("2026-05-19T17:00:00-04:00");
    const displayYmd = nyseDisplaySessionYmd(afterClose);
    const fromDisplay = computeEquityMtmClp(acct.account_id, displayYmd);
    const sync = computeEquityMtmClpDisplaySync(acct.account_id, afterClose);
    if (fromDisplay == null || sync == null) return;
    expect(sync.as_of_date).toBe(displayYmd);
    expect(sync.value_clp).toBe(fromDisplay);
  });
});
