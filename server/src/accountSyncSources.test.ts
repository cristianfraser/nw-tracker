import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  inferSyncSourcesForAccount,
  reseedAccountSyncSources,
  reseedAllAccountSyncSources,
  syncSourcesForAccountId,
} from "./accountSyncSources.js";

describe("accountSyncSources", () => {
  it("infers fintual for cert v2 notes", () => {
    expect(
      inferSyncSourcesForAccount({
        id: 1,
        notes: "import:fintual|cert|key=apv_a",
        equity_ticker: null,
        fund_series_key: null,
      })
    ).toEqual(["fintual"]);
  });

  it("infers fintual for legacy fund series from excel notes", () => {
    expect(
      inferSyncSourcesForAccount({
        id: 1,
        notes: "import:excel|key=fintual_rn",
        equity_ticker: null,
        fund_series_key: null,
      })
    ).toEqual(["fintual"]);
  });

  it("infers afp_uno for AFP excel account", () => {
    expect(
      inferSyncSourcesForAccount({
        id: 1,
        notes: "import:excel|key=afp",
        equity_ticker: null,
        fund_series_key: null,
      })
    ).toEqual(["afp_uno"]);
  });

  it("infers stocks_nyse and crypto_eod from equity_ticker", () => {
    expect(
      inferSyncSourcesForAccount({
        id: 1,
        notes: "import:panel|ticker=SPY|key=x",
        equity_ticker: "SPY",
        fund_series_key: null,
      })
    ).toEqual(["stocks_nyse"]);
    expect(
      inferSyncSourcesForAccount({
        id: 2,
        notes: "import:panel|ticker=BTC-USD|key=y",
        equity_ticker: "BTC-USD",
        fund_series_key: null,
      })
    ).toEqual(["crypto_eod"]);
  });

  it("returns no sources for book-value accounts", () => {
    expect(
      inferSyncSourcesForAccount({
        id: 1,
        notes: "import:excel|key=checking",
        equity_ticker: null,
        fund_series_key: null,
      })
    ).toEqual([]);
  });

  it("reseedAllAccountSyncSources persists rows for synced accounts", () => {
    const fintual = db
      .prepare(`SELECT id FROM accounts WHERE notes LIKE 'import:fintual|cert|key=%' LIMIT 1`)
      .get() as { id: number } | undefined;
    const afp = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'import:excel|key=afp' LIMIT 1`)
      .get() as { id: number } | undefined;
    const equity = db
      .prepare(`SELECT id FROM accounts WHERE equity_ticker IS NOT NULL LIMIT 1`)
      .get() as { id: number } | undefined;

    const { links } = reseedAllAccountSyncSources();
    expect(links).toBeGreaterThan(0);

    if (fintual) {
      expect(syncSourcesForAccountId(fintual.id)).toContain("fintual");
    }
    if (afp) {
      expect(syncSourcesForAccountId(afp.id)).toEqual(["afp_uno"]);
    }
    if (equity) {
      const sources = syncSourcesForAccountId(equity.id);
      expect(sources.some((s) => s === "stocks_nyse" || s === "crypto_eod")).toBe(true);
    }
  });

  it("reseedAccountSyncSources replaces links for one account", () => {
    const account = db
      .prepare(`SELECT id FROM accounts ORDER BY id LIMIT 1`)
      .get() as { id: number } | undefined;
    expect(account).toBeTruthy();
    const sources = reseedAccountSyncSources(account!.id);
    expect(syncSourcesForAccountId(account!.id)).toEqual(sources);
  });
});
