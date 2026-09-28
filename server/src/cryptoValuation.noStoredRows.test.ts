import { afterEach, describe, expect, it, vi } from "vitest";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { getAccountMonthlyPerformance } from "./accountPerformance.js";
import { clearAggregationCache } from "./aggregationCache.js";
import { expandSnapshotDatesForCryptoMtm, requireCryptoMtmClp } from "./cryptoValuation.js";
import { db } from "./db.js";

/**
 * Crypto is marked from units × close × fx only: no stored `valuations` rows, no fallback to
 * them. Synthetic far-future fixture on the Chile clock of 2099-03-15: 0.5 BTC bought
 * 2099-01-10, closes of US$40,000 (2099-01-31), US$50,000 (2099-02-28) and US$60,000
 * (2099-03-14) with stored fx 900 / 1000 / 1100 on those days, and one bar dated after today
 * (2099-04-02) that must not push the grid past the current month-end.
 */
describe("crypto valuation without stored rows", () => {
  const TICKER = "BTC-USD";
  const UNITS = 0.5;
  const PREFIX = "vitest-crypto-nostored";
  const createdIds: number[] = [];

  function leafId(): number | null {
    const leaf = db
      .prepare(`SELECT id FROM asset_groups WHERE slug = 'brokerage_crypto__bitcoin' LIMIT 1`)
      .get() as { id: number } | undefined;
    return leaf?.id ?? null;
  }

  function createAccount(leaf: number, suffix: string, buyYmd: string): number {
    const id = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, import_key, equity_ticker)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(leaf, `Vitest · ${suffix}`, `${PREFIX}-${suffix}`, `${PREFIX}-${suffix}`, TICKER)
        .lastInsertRowid
    );
    createdIds.push(id);
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
       VALUES (?, 18000000, 'clp', ?, ?, ?)`
    ).run(id, buyYmd, `${PREFIX}-${suffix}-buy`, UNITS);
    return id;
  }

  function seedMarket(): void {
    const bars: [string, number, number][] = [
      ["2099-01-31", 40_000, 900],
      ["2099-02-28", 50_000, 1000],
      ["2099-03-14", 60_000, 1100],
    ];
    for (const [d, close, fx] of bars) {
      db.prepare(
        `INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'usd')`
      ).run(TICKER, d, close);
      db.prepare(`INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, ?)`).run(d, fx);
    }
    db.prepare(
      `INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, '2099-04-02', 70000, 'usd')`
    ).run(TICKER);
  }

  afterEach(() => {
    vi.useRealTimers();
    db.prepare(`DELETE FROM fx_daily WHERE date >= '2099-01-01'`).run();
    db.prepare(`DELETE FROM equity_daily WHERE ticker = ? AND trade_date >= '2099-01-01'`).run(TICKER);
    for (const id of createdIds) {
      db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    }
    createdIds.length = 0;
    clearAggregationCache();
  });

  function atChileMidMarch(): void {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-03-15T15:00:00.000Z"));
  }

  it("charts month-ends through the current month-end and never later", () => {
    const leaf = leafId();
    if (leaf == null) return;
    seedMarket();
    const id = createAccount(leaf, "grid", "2099-01-10");
    atChileMidMarch();

    const grid = expandSnapshotDatesForCryptoMtm([], [id]).filter((d) => d >= "2099-01-01");
    expect(grid).toEqual(["2099-01-31", "2099-02-28", "2099-03-15", "2099-03-31"]);
  });

  it("marks and monthly closes are units × close × fx, ignoring any stored row", () => {
    const leaf = leafId();
    if (leaf == null) return;
    seedMarket();
    const id = createAccount(leaf, "marks", "2099-01-10");
    // A stale stored row must not leak into any surface.
    db.prepare(
      `INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, '2099-02-28', 1, 'clp')`
    ).run(id);
    atChileMidMarch();

    expect(accountMarkClpAtYmd(id, "2099-01-31")?.value_clp).toBeCloseTo(UNITS * 40_000 * 900, 2);
    expect(accountMarkClpAtYmd(id, "2099-02-28")?.value_clp).toBeCloseTo(UNITS * 50_000 * 1000, 2);
    // Before the purchase the account holds nothing.
    expect(accountMarkClpAtYmd(id, "2099-01-05")?.value_clp).toBe(0);

    const perf = getAccountMonthlyPerformance(id, "clp");
    const byDate = new Map(perf!.monthly.map((r) => [r.as_of_date, r.closing_value]));
    expect(byDate.get("2099-01-31")).toBeCloseTo(UNITS * 40_000 * 900, 2);
    expect(byDate.get("2099-02-28")).toBeCloseTo(UNITS * 50_000 * 1000, 2);
  });

  it("throws on a held date with no coin close on or before it", () => {
    const leaf = leafId();
    if (leaf == null) return;
    // Decades before any seeded bar: the units are held, the price does not exist.
    const id = createAccount(leaf, "gap", "1901-01-10");
    atChileMidMarch();

    expect(() => requireCryptoMtmClp(id, "1901-02-28")).toThrow(/cannot mark 1901-02-28/);
    expect(() => accountMarkClpAtYmd(id, "1901-02-28")).toThrow(/cannot mark 1901-02-28/);
  });
});
