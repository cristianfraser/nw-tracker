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
    // Own fixtures — one account per inference rule (fintual / afp_uno / equity ticker).
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as {
      id: number;
    };
    const mk = (name: string, notes: string, ticker: string | null) =>
      Number(
        db
          .prepare(
            `INSERT INTO accounts (asset_group_id, name, notes, equity_ticker) VALUES (?, ?, ?, ?)`
          )
          .run(group.id, name, notes, ticker).lastInsertRowid
      );
    const fintualId = mk("Sync fixture fintual", "import:fintual|cert|key=apv_b", null);
    const hadAfp =
      db.prepare(`SELECT 1 FROM accounts WHERE notes = 'import:excel|key=afp'`).get() != null;
    const afpId = hadAfp ? null : mk("Sync fixture AFP", "import:excel|key=afp", null);
    const equityId = mk("Sync fixture SPY", "test:sync-fixture-spy", "SPY");

    try {
      const { links } = reseedAllAccountSyncSources();
      expect(links).toBeGreaterThan(0);

      expect(syncSourcesForAccountId(fintualId)).toContain("fintual");
      if (afpId != null) {
        expect(syncSourcesForAccountId(afpId)).toEqual(["afp_uno"]);
      }
      expect(syncSourcesForAccountId(equityId)).toContain("stocks_nyse");
    } finally {
      const ids = [fintualId, afpId, equityId].filter((x): x is number => x != null);
      for (const id of ids) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
      reseedAllAccountSyncSources();
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
