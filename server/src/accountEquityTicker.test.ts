import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  equityTickerForAccount,
  listDistinctEquityTickersForSync,
  listNyseEquityTickersForEodSync,
} from "./accountEquityTicker.js";

describe("accountEquityTicker", () => {
  it("backfill sets equity_ticker on legacy excel SPY account", () => {
    const row = db
      .prepare(
        `SELECT id, equity_ticker FROM accounts WHERE notes = 'import:excel|key=spy' LIMIT 1`
      )
      .get() as { id: number; equity_ticker: string | null } | undefined;
    if (!row) return;
    expect(row.equity_ticker).toBe("SPY");
    expect(equityTickerForAccount(row.id)).toBe("SPY");
  });

  it("listDistinctEquityTickersForSync includes built-in symbols when present on accounts", () => {
    const tickers = listDistinctEquityTickersForSync();
    const hasSpy = db
      .prepare(`SELECT 1 FROM accounts WHERE equity_ticker = 'SPY' LIMIT 1`)
      .get();
    if (hasSpy) expect(tickers).toContain("SPY");
  });

  it("listNyseEquityTickersForEodSync excludes crypto symbols", () => {
    const nyse = listNyseEquityTickersForEodSync();
    expect(nyse).not.toContain("BTC-USD");
    expect(nyse).not.toContain("ETH-USD");
  });
});
