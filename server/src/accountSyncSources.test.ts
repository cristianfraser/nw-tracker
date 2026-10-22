import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  inferSyncSourcesForAccount,
  reseedAccountSyncSources,
  reseedAllAccountSyncSources,
  syncSourcesForAccountId,
} from "./accountSyncSources.js";
import { AFP_UNO_CUOTA_SERIES_KEY } from "./afpUnoSeries.js";

describe("accountSyncSources", () => {
  it("infers fintual for cert v2 notes", () => {
    expect(
      inferSyncSourcesForAccount({
        id: 1,
        import_key: "import:fintual|cert|key=apv_a",
        equity_ticker: null,
        fund_series_key: null,
      })
    ).toEqual(["fintual"]);
  });

  it("infers fintual for legacy fund series from excel notes", () => {
    expect(
      inferSyncSourcesForAccount({
        id: 1,
        import_key: "import:excel|key=fintual_rn",
        equity_ticker: null,
        fund_series_key: null,
      })
    ).toEqual(["fintual"]);
  });

  it("infers afp_uno for the account declared on the UNO Fondo A series, whatever its import key", () => {
    expect(
      inferSyncSourcesForAccount({
        id: 1,
        import_key: "import:afp|afp=uno|fund=A",
        equity_ticker: null,
        fund_series_key: AFP_UNO_CUOTA_SERIES_KEY,
      })
    ).toEqual(["afp_uno"]);
    // The legacy import key alone no longer names the live account …
    expect(
      inferSyncSourcesForAccount({
        id: 1,
        import_key: "import:excel|key=afp",
        equity_ticker: null,
        fund_series_key: null,
      })
    ).toEqual([]);
    // … and an earlier fund of the chain is not synced by the UNO source.
    expect(
      inferSyncSourcesForAccount({
        id: 1,
        import_key: "import:afp|afp=planvital|fund=A",
        equity_ticker: null,
        fund_series_key: "afp_planvital_cuota_a",
      })
    ).toEqual([]);
  });

  it("infers afc_cic for an account declared on the AFC CIC series", () => {
    expect(
      inferSyncSourcesForAccount({
        id: 1,
        import_key: "import:excel|key=afc",
        equity_ticker: null,
        fund_series_key: "afc_cic",
      })
    ).toEqual(["afc_cic"]);
    expect(
      inferSyncSourcesForAccount({
        id: 1,
        import_key: "import:excel|key=afc",
        equity_ticker: null,
        fund_series_key: null,
      })
    ).toEqual([]);
  });

  it("infers stocks_santiago for Bolsa de Santiago (.SN) tickers", () => {
    expect(
      inferSyncSourcesForAccount({
        id: 3,
        import_key: "import:panel|ticker=VITEST.SN|key=z",
        equity_ticker: "VITEST.SN",
        fund_series_key: null,
      })
    ).toEqual(["stocks_santiago"]);
  });

  it("infers stocks_nyse and crypto_eod from equity_ticker", () => {
    expect(
      inferSyncSourcesForAccount({
        id: 1,
        import_key: "import:panel|ticker=SPY|key=x",
        equity_ticker: "SPY",
        fund_series_key: null,
      })
    ).toEqual(["stocks_nyse"]);
    expect(
      inferSyncSourcesForAccount({
        id: 2,
        import_key: "import:panel|ticker=BTC-USD|key=y",
        equity_ticker: "BTC-USD",
        fund_series_key: null,
      })
    ).toEqual(["crypto_eod"]);
  });

  it("returns no sources for book-value accounts", () => {
    expect(
      inferSyncSourcesForAccount({
        id: 1,
        import_key: "import:excel|key=checking",
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
    const mk = (name: string, notes: string, ticker: string | null, seriesKey: string | null = null) =>
      Number(
        db
          .prepare(
            `INSERT INTO accounts (asset_group_id, name, notes, import_key, equity_ticker, fund_series_key)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(group.id, name, notes, notes, ticker, seriesKey).lastInsertRowid
      );
    const fintualId = mk("Sync fixture fintual", "import:fintual|cert|key=apv_b", null);
    const afpId = mk("Sync fixture AFP", "test:sync-fixture-afp", null, AFP_UNO_CUOTA_SERIES_KEY);
    const equityId = mk("Sync fixture SPY", "test:sync-fixture-spy", "SPY");

    try {
      const { links } = reseedAllAccountSyncSources();
      expect(links).toBeGreaterThan(0);

      expect(syncSourcesForAccountId(fintualId)).toContain("fintual");
      expect(syncSourcesForAccountId(afpId)).toEqual(["afp_uno"]);
      expect(syncSourcesForAccountId(equityId)).toContain("stocks_nyse");
    } finally {
      for (const id of [fintualId, afpId, equityId]) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
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
