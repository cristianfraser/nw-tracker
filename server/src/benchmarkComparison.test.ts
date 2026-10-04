import { afterAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { shadowOverWindow } from "./benchmarkComparison.js";
import {
  benchmarkLevelSeries,
  getBenchmark,
  listBenchmarks,
  totalReturnFactors,
  type BenchmarkRow,
} from "./benchmarkLevels.js";
import { insertEquityDividendsIfMissing } from "./equityDividends.js";

const levels: Record<string, number> = {
  "2026-01-31": 1,
  "2026-02-15": 2,
  "2026-02-20": 3,
  "2026-02-28": 4,
};
const level = (ymd: string): number | null => levels[ymd] ?? null;

describe("shadowOverWindow", () => {
  it("with no flows, earns the start value at the benchmark's return", () => {
    const r = shadowOverWindow(100, "2026-01-31", "2026-02-28", [], level)!;
    expect(r.benchmark_pct).toBeCloseTo(3);
    expect(r.shadow_pl).toBeCloseTo(300);
  });

  it("buys benchmark units with each deposit at that day's level", () => {
    // 100 units at 1, a deposit of 100 buys 50 more at 2; 150 units at 4 = 600.
    const r = shadowOverWindow(
      100,
      "2026-01-31",
      "2026-02-28",
      [{ ymd: "2026-02-15", amount: 100 }],
      level
    )!;
    expect(r.shadow_pl).toBeCloseTo(600 - 100 - 100);
    expect(r.benchmark_pct).toBeCloseTo(3);
  });

  it("goes short when a withdrawal exceeds what the shadow holds, keeping the identity", () => {
    // 0 units; withdraw 300 at 3 → −100 units; end −400. P/L = −400 − 0 − (−300) = −100.
    const r = shadowOverWindow(
      0,
      "2026-01-31",
      "2026-02-28",
      [{ ymd: "2026-02-20", amount: -300 }],
      level
    )!;
    expect(r.shadow_pl).toBeCloseTo(-100);
  });

  it("ignores flows outside (start, end]", () => {
    const r = shadowOverWindow(
      100,
      "2026-01-31",
      "2026-02-28",
      [
        { ymd: "2026-01-31", amount: 50 },
        { ymd: "2026-03-01", amount: 50 },
      ],
      level
    )!;
    expect(r.shadow_pl).toBeCloseTo(300);
  });

  it("an empty start measures the benchmark from the first flow", () => {
    // The window opens before the benchmark exists; the money arrives on 2026-02-15.
    const r = shadowOverWindow(
      0,
      "2025-12-31",
      "2026-02-28",
      [{ ymd: "2026-02-15", amount: 100 }],
      level
    )!;
    expect(r.benchmark_pct).toBeCloseTo(1);
    expect(r.shadow_pl).toBeCloseTo(100);
  });

  it("is null when the benchmark has no level at the start or on a flow day", () => {
    expect(shadowOverWindow(100, "2025-12-31", "2026-02-28", [], level)).toBeNull();
    expect(
      shadowOverWindow(100, "2026-01-31", "2026-02-28", [{ ymd: "2026-02-10", amount: 1 }], level)
    ).toBeNull();
  });
});

describe("totalReturnFactors", () => {
  it("reinvests each dividend at its ex-date close, net of withholding", () => {
    const f = totalReturnFactors(
      ["2026-01-02", "2026-01-05", "2026-01-06"],
      [100, 50, 100],
      [{ ex_date: "2026-01-05", amount: 1 }],
      15
    );
    expect(f[0]).toBe(1);
    expect(f[1]).toBeCloseTo(1 + 0.85 / 50);
    expect(f[2]).toBeCloseTo(1 + 0.85 / 50);
  });

  it("throws on a dividend whose ex-date has no close inside the series", () => {
    expect(() =>
      totalReturnFactors(["2026-01-02", "2026-01-06"], [100, 100], [{ ex_date: "2026-01-05", amount: 1 }], 15)
    ).toThrow(/no close/);
  });
});

describe("benchmark levels (synthetic ticker)", () => {
  const TICKER = "ZZBENCHTEST";
  const bench: BenchmarkRow = {
    slug: "zz_test",
    kind: "equity_with_dividends",
    label_i18n_key: "x",
    ticker: TICKER,
    withholding_pct: 15,
    series_key: null,
    index_key: null,
    rate_pct: null,
    sort_order: 0,
  };
  const cleanup = () => {
    db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(TICKER);
    db.prepare(`DELETE FROM equity_dividends WHERE ticker = ?`).run(TICKER);
  };
  afterAll(cleanup);

  it("levels carry the reinvested dividend; a stale series throws", () => {
    cleanup();
    const ins = db.prepare(
      `INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'usd')`
    );
    ins.run(TICKER, "2020-01-02", 100);
    ins.run(TICKER, "2020-01-03", 100);
    ins.run(TICKER, "2020-01-06", 100);
    insertEquityDividendsIfMissing(TICKER, [{ ex_date: "2020-01-03", amount: 2 }]);

    const s = benchmarkLevelSeries(bench, "2099-01-01");
    expect(s.currency).toBe("usd");
    expect(s.first_ymd).toBe("2020-01-02");
    expect(s.levelAt("2020-01-01")).toBeNull();
    expect(s.levelAt("2020-01-02")).toBeCloseTo(100);
    expect(s.levelAt("2020-01-04")).toBeCloseTo(100 * (1 + 1.7 / 100));
    expect(() => s.levelAt("2020-02-01")).toThrow(/sync the series/);
  });

  it("dividends are write-once: a different amount for a stored ex-date throws", () => {
    expect(insertEquityDividendsIfMissing(TICKER, [{ ex_date: "2020-01-03", amount: 2 }]).inserted).toBe(0);
    expect(() => insertEquityDividendsIfMissing(TICKER, [{ ex_date: "2020-01-03", amount: 2.5 }])).toThrow(
      /stored 2/
    );
  });
});

describe("seeded benchmarks", () => {
  it("lists the mortgage first and resolves each kind", () => {
    const all = listBenchmarks();
    expect(all[0]?.slug).toBe("mortgage");
    expect(all.map((b) => b.kind).sort()).toEqual(
      ["equity_with_dividends", "fund_unit", "index_plus_rate", "index_plus_rate"].sort()
    );
  });

  it("UF + rate compounds the UF ratio at the yearly rate", () => {
    const mortgage = getBenchmark("mortgage")!;
    const uf = getBenchmark("uf")!;
    const row = db
      .prepare(`SELECT MIN(date) AS a, MAX(date) AS b FROM uf_daily`)
      .get() as { a: string | null; b: string | null };
    if (row.a == null || row.b == null) return;
    const m = benchmarkLevelSeries(mortgage, "2099-01-01");
    const u = benchmarkLevelSeries(uf, "2099-01-01");
    const a = row.a;
    const b = row.b;
    const days = (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
    const ufRatio = u.levelAt(b)! / u.levelAt(a)!;
    expect(m.levelAt(b)! / m.levelAt(a)!).toBeCloseTo(ufRatio * Math.pow(1.0495, days / 365), 10);
  });
});
