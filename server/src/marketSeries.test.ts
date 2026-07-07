import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { db } from "./db.js";
import { snapshotTables } from "./test/snapshotTables.js";
import { getMarketSeriesPayload } from "./marketSeries.js";

// The payload reads whole tables; pin every input so assertions are exact.
const restoreTables = snapshotTables([
  "fx_daily",
  "fx_daily_bcentral",
  "fx_daily_bid_ask",
  "uf_daily",
  "eur_daily",
  "ipc_daily",
  "utm_daily",
  "equity_daily",
  "fund_unit_daily",
]);
afterAll(() => restoreTables());

const USD_TICKER = "VTST";
const CLP_TICKER = "VITEST.SN"; // .SN → quoted in CLP (equityQuoteCurrency)
const FUND_KEY = "vitest_fund";

beforeAll(() => {
  for (const t of [
    "fx_daily",
    "fx_daily_bcentral",
    "fx_daily_bid_ask",
    "uf_daily",
    "eur_daily",
    "ipc_daily",
    "utm_daily",
    "equity_daily",
    "fund_unit_daily",
  ]) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare(`INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, ?)`).run("2024-01-02", 900);
  db.prepare(`INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, ?)`).run("2024-01-04", 910);
  db.prepare(`INSERT INTO fx_daily_bcentral (date, clp_per_usd) VALUES (?, ?)`).run(
    "2024-01-02",
    902
  );
  db.prepare(
    `INSERT INTO fx_daily_bid_ask (date, buy_clp_per_usd, sell_clp_per_usd, source) VALUES (?, ?, ?, ?)`
  ).run("2024-01-02", 915, 895, "vitest");
  db.prepare(`INSERT INTO uf_daily (date, clp_per_uf) VALUES (?, ?)`).run("2024-01-03", 36_000);
  db.prepare(`INSERT INTO eur_daily (date, clp_per_eur) VALUES (?, ?)`).run("2024-01-02", 980);
  db.prepare(`INSERT INTO ipc_daily (date, ipc_index) VALUES (?, ?)`).run("2024-01-02", 130.5);
  db.prepare(`INSERT INTO utm_daily (date, utm_clp) VALUES (?, ?)`).run("2024-01-02", 65_000);

  const insEq = db.prepare(
    `INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, ?)`
  );
  insEq.run(USD_TICKER, "2024-01-02", 470, "usd");
  insEq.run(USD_TICKER, "2024-01-04", 480, "usd");
  insEq.run(CLP_TICKER, "2024-01-02", 5000, "clp");

  db.prepare(`INSERT INTO fund_unit_daily (series_key, day, unit_value_clp) VALUES (?, ?, ?)`).run(
    FUND_KEY,
    "2024-01-04",
    1234.5
  );
});

describe("getMarketSeriesPayload", () => {
  it("emits one point per date with data, on-date values only for scalar series", () => {
    const p = getMarketSeriesPayload();
    expect(p.points.map((pt) => pt.as_of_date)).toEqual(["2024-01-02", "2024-01-03", "2024-01-04"]);

    const [d2, d3, d4] = p.points as [
      (typeof p.points)[number],
      (typeof p.points)[number],
      (typeof p.points)[number],
    ];
    expect(d2.clp_per_usd).toBe(900);
    expect(d2.clp_per_uf).toBeNull();
    expect(d2.clp_per_eur).toBe(980);
    expect(d2.ipc_index).toBe(130.5);
    expect(d2.utm_clp).toBe(65_000);

    // UF-only date: fx is not "on date" even though a prior row exists.
    expect(d3.clp_per_usd).toBeNull();
    expect(d3.clp_per_uf).toBe(36_000);

    expect(d4.clp_per_usd).toBe(910);
    expect(d4.clp_per_uf).toBeNull();
  });

  it("converts usd-quoted closes to CLP and clp-quoted (.SN) closes to USD at carried fx", () => {
    const p = getMarketSeriesPayload();
    const [d2, d3, d4] = p.points as [
      (typeof p.points)[number],
      (typeof p.points)[number],
      (typeof p.points)[number],
    ];

    expect(d2.equity_usd[USD_TICKER]).toBe(470);
    expect(d2.equity_clp[USD_TICKER]).toBe(470 * 900);
    expect(d2.equity_clp[CLP_TICKER]).toBe(5000);
    expect(d2.equity_usd[CLP_TICKER]).toBeCloseTo(5000 / 900, 10);

    // No bar on the date → null, even with an earlier bar (charts skip, no forward-fill).
    expect(d3.equity_usd[USD_TICKER]).toBeNull();
    expect(d3.equity_clp[CLP_TICKER]).toBeNull();

    expect(d4.equity_usd[USD_TICKER]).toBe(480);
    expect(d4.equity_clp[USD_TICKER]).toBe(480 * 910);
    expect(d4.equity_usd[CLP_TICKER]).toBeNull();
  });

  it("emits fund units in CLP with a USD leg at carried fx", () => {
    const p = getMarketSeriesPayload();
    expect(p.fund_series_keys).toEqual([FUND_KEY]);
    const d4 = p.points[2]!;
    expect(d4.fund_unit_clp[FUND_KEY]).toBe(1234.5);
    expect(d4.fund_unit_usd[FUND_KEY]).toBeCloseTo(1234.5 / 910, 10);
    expect(p.points[0]!.fund_unit_clp[FUND_KEY]).toBeNull();
  });

  it("passes through the FX reference arrays", () => {
    const p = getMarketSeriesPayload();
    expect(p.equity_tickers).toEqual([CLP_TICKER, USD_TICKER]);
    expect(p.fx_usd_clp).toEqual([
      { date: "2024-01-02", value: 900 },
      { date: "2024-01-04", value: 910 },
    ]);
    expect(p.fx_usd_clp_bcentral).toEqual([{ date: "2024-01-02", value: 902 }]);
    expect(p.fx_usd_clp_buy).toEqual([{ date: "2024-01-02", value: 915 }]);
    expect(p.fx_usd_clp_sell).toEqual([{ date: "2024-01-02", value: 895 }]);
    expect(p.eur_clp).toEqual([{ date: "2024-01-02", value: 980 }]);
    expect(p.fx_coverage).toBeTruthy();
    expect(p.fx_coverage.row_count).toBe(2);
  });
});
