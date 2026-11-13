import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
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
  "fx_rates",
]);
afterAll(() => restoreTables());

const USD_TICKER = "VTST";
const CLP_TICKER = "VITEST.SN"; // .SN → quoted in CLP (equityQuoteCurrency)
const FUND_KEY = "vitest_fund";

// Seeds every table the payload reads, wiping it first. The payload reads whole tables, so a row
// another writer adds during this file (a crypto history, a fx backfill) would reach the date and
// ticker lists; re-seeding before each test keeps every assertion on this file's own fixtures.
function seedFixtures(): void {
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
    "fx_rates",
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
  const insEurUsd = db.prepare(
    `INSERT INTO fx_rates (base, quote, date, mid, source) VALUES ('eur', 'usd', ?, ?, 'vitest')`
  );
  insEurUsd.run("2024-01-02", 1.09);
  insEurUsd.run("2024-01-04", 1.1);
  db.prepare(`INSERT INTO ipc_daily (date, ipc_index) VALUES (?, ?)`).run("2024-01-02", 130.5);
  db.prepare(`INSERT INTO utm_daily (date, utm_clp) VALUES (?, ?)`).run("2024-01-02", 65_000);

  const insEq = db.prepare(
    `INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, ?)`
  );
  insEq.run(USD_TICKER, "2024-01-02", 470, "usd");
  insEq.run(USD_TICKER, "2024-01-04", 480, "usd");
  insEq.run(CLP_TICKER, "2024-01-02", 5000, "clp");

  db.prepare(`INSERT INTO fund_unit_daily (series_key, day, unit_value) VALUES (?, ?, ?)`).run(
    FUND_KEY,
    "2024-01-04",
    1234.5
  );
}

beforeAll(seedFixtures);
beforeEach(seedFixtures);

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

  it("expresses usd-quoted and clp-quoted (.SN) closes in the requested unit at carried fx", () => {
    const clp = getMarketSeriesPayload("clp");
    const usd = getMarketSeriesPayload("usd");
    expect(clp.unit).toBe("clp");
    expect(usd.unit).toBe("usd");
    const [c2, c3, c4] = clp.points as [(typeof clp.points)[number], (typeof clp.points)[number], (typeof clp.points)[number]];
    const [u2, u3, u4] = usd.points as [(typeof usd.points)[number], (typeof usd.points)[number], (typeof usd.points)[number]];

    expect(u2.equity[USD_TICKER]).toBe(470);
    expect(c2.equity[USD_TICKER]).toBe(470 * 900);
    expect(c2.equity[CLP_TICKER]).toBe(5000);
    expect(u2.equity[CLP_TICKER]).toBe(5000 / 900);

    // No bar on the date → null, even with an earlier bar (charts skip, no forward-fill).
    expect(u3.equity[USD_TICKER]).toBeNull();
    expect(c3.equity[CLP_TICKER]).toBeNull();

    expect(u4.equity[USD_TICKER]).toBe(480);
    expect(c4.equity[USD_TICKER]).toBe(480 * 910);
    expect(u4.equity[CLP_TICKER]).toBeNull();
    // The point set does not depend on the unit.
    expect(usd.points.map((p) => p.as_of_date)).toEqual(clp.points.map((p) => p.as_of_date));
  });

  it("emits fund units in the requested unit at carried fx", () => {
    const clp = getMarketSeriesPayload("clp");
    const usd = getMarketSeriesPayload("usd");
    expect(clp.fund_series_keys).toEqual([FUND_KEY]);
    expect(clp.points[2]!.fund_unit[FUND_KEY]).toBe(1234.5);
    expect(usd.points[2]!.fund_unit[FUND_KEY]).toBe(1234.5 / 910);
    expect(clp.points[0]!.fund_unit[FUND_KEY]).toBeNull();
  });

  it("expresses closes and cuotas in EUR through the rates walk (EUR/USD, EUR/CLP)", () => {
    const eur = getMarketSeriesPayload("eur");
    expect(eur.unit).toBe("eur");
    const [e2, , e4] = eur.points as [(typeof eur.points)[number], (typeof eur.points)[number], (typeof eur.points)[number]];
    expect(e2.equity[USD_TICKER]).toBeCloseTo(470 / 1.09, 9);
    expect(e4.equity[USD_TICKER]).toBeCloseTo(480 / 1.1, 9);
    expect(e2.equity[CLP_TICKER]).toBeCloseTo(5000 / 980, 9);
    // 2024-01-04 has no EUR/CLP row: the 2024-01-02 one carries.
    expect(e4.fund_unit[FUND_KEY]).toBeCloseTo(1234.5 / 980, 9);
    // Rate fields stay facts in their own quote.
    expect(e2.clp_per_usd).toBe(900);
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
    expect(p.eur_usd).toEqual([
      { date: "2024-01-02", value: 1.09 },
      { date: "2024-01-04", value: 1.1 },
    ]);
    expect(p.fx_coverage).toBeTruthy();
    expect(p.fx_coverage.unit).toBe("clp");
    expect(p.fx_coverage.pairs.find((x) => x.base === "usd" && x.quote === "clp")?.row_count).toBe(2);
  });
});
