import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  equityTickerForAccount,
  listDistinctEquityTickersForSync,
  listNyseEquityTickersForEodSync,
} from "./accountEquityTicker.js";

describe("accountEquityTicker", () => {
  it("reads a stock account's ticker from accounts.equity_ticker", () => {
    const row = db.prepare(`SELECT id FROM accounts WHERE import_key = 'import:panel|ticker=SPY|key=demo_spy'`).get() as { id: number };
    expect(equityTickerForAccount(row.id)).toBe("SPY");
  });

  it("listDistinctEquityTickersForSync includes the tickers held on accounts", () => {
    expect(listDistinctEquityTickersForSync()).toEqual(expect.arrayContaining(["SPY", "AAPL"]));
  });

  it("listNyseEquityTickersForEodSync excludes crypto symbols", () => {
    const nyse = listNyseEquityTickersForEodSync();
    expect(nyse).not.toContain("BTC-USD");
    expect(nyse).not.toContain("ETH-USD");
  });
});
