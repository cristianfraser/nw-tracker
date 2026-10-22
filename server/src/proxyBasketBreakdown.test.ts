import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chileCalendarAddDays } from "./chileDate.js";
import { db } from "./db.js";
import { observadoFrameFxForDay } from "./fxObservadoFrame.js";
import { loadProxyBasketBreakdown } from "./proxyBasketBreakdown.js";
import { recordCompositePositions, type CompositePositionHolding } from "./watchlistCompositeHistory.js";

/**
 * Wednesday 2026-07-15, 19:30 Chile (after the NYSE close): today = 2026-07-15, anchors
 * day 2026-07-14, month 2026-06-30, year 2025-12-31. The window sits inside the test DB's
 * dólar observado rows (weekly, so every day has a publication within 7 days after it).
 */
const NOW = new Date("2026-07-15T23:30:00Z");
const TODAY = "2026-07-15";
const YEAR_ANCHOR = "2025-12-31";
const MONTH_ANCHOR = "2026-06-30";
const DAY_ANCHOR = "2026-07-14";

const T1 = "VTPB1";
const T2 = "VTPB2";
const BUCKET_PREFIX = "vitest_proxy_breakdown";
const BUCKETS = ["all", "entered", "returned", "late", "no_sum"].map((s) => `${BUCKET_PREFIX}_${s}`);

/** Weekday closes 2025-12-29 → today; a weekend repeats Friday's close (on-or-before). */
const closes = new Map<string, Map<string, number>>([[T1, new Map()], [T2, new Map()]]);

function isWeekend(ymd: string): boolean {
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

function priceOnOrBefore(ticker: string, ymd: string): number {
  const series = closes.get(ticker)!;
  let d = ymd;
  for (let i = 0; i < 10; i++) {
    const c = series.get(d);
    if (c != null) return c;
    d = chileCalendarAddDays(d, -1);
  }
  throw new Error(`fixture: no close on or before ${ymd} for ${ticker}`);
}

function fx(ymd: string): number {
  return observadoFrameFxForDay(ymd, NOW).clp_per_usd;
}

function clpValue(ticker: string, ymd: string): number {
  return priceOnOrBefore(ticker, ymd) * fx(ymd);
}

/** Σ weight(d) × r(d) over the held days, in USD, from the fixture closes. */
function contributionUsd(
  ticker: string,
  anchor: string,
  weightOnPrevDay: (prevDay: string) => number
): number {
  let sum = 0;
  let prevDay = anchor;
  for (let d = chileCalendarAddDays(anchor, 1); d <= TODAY; d = chileCalendarAddDays(d, 1)) {
    const w = weightOnPrevDay(prevDay);
    if (w > 0) sum += w * (priceOnOrBefore(ticker, d) / priceOnOrBefore(ticker, prevDay) - 1);
    prevDay = d;
  }
  return sum;
}

function record(bucket: string, positionsDate: string, etfWeightSum: number | null, holdings: CompositePositionHolding[]) {
  const res = recordCompositePositions({
    bucket_slug: bucket,
    positions_date: positionsDate,
    etf_weight_sum: etfWeightSum,
    source: "sync",
    holdings,
  });
  if (res.status !== "inserted") throw new Error(`fixture: ${bucket} ${positionsDate} ${res.status}`);
}

beforeAll(() => {
  const insert = db.prepare(`INSERT OR REPLACE INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'usd')`);
  let k = 0;
  for (let d = "2025-12-29"; d <= TODAY; d = chileCalendarAddDays(d, 1)) {
    if (isWeekend(d)) continue;
    k += 1;
    // Two series that move differently, never flat, never monotone.
    const p1 = 100 * (1 + 0.0015 * k + 0.02 * Math.sin(k / 3));
    const p2 = 40 * (1 - 0.0008 * k + 0.03 * Math.cos(k / 5));
    closes.get(T1)!.set(d, p1);
    closes.get(T2)!.set(d, p2);
    insert.run(T1, d, p1);
    insert.run(T2, d, p2);
  }
});

afterEach(() => {
  for (const b of BUCKETS) db.prepare(`DELETE FROM watchlist_composite_positions WHERE bucket_slug = ?`).run(b);
});

afterAll(() => {
  db.prepare(`DELETE FROM equity_daily WHERE ticker IN (?, ?)`).run(T1, T2);
});

describe("loadProxyBasketBreakdown", () => {
  it("returns null for a bucket with no stated basket", () => {
    expect(loadProxyBasketBreakdown(`${BUCKET_PREFIX}_absent`, { now: NOW, includeUsd: true })).toBeNull();
  });

  it("a holding held all period: pct is the plain price return in both units, weights scale by the sleeve", () => {
    const bucket = `${BUCKET_PREFIX}_all`;
    record(bucket, "2025-12-15", 0.9, [
      { ticker: T2, weight: 0.4 },
      { ticker: T1, weight: 0.6 },
    ]);

    const out = loadProxyBasketBreakdown(bucket, { now: NOW, includeUsd: true });
    expect(out).not.toBeNull();
    expect(out!.positions_date).toBe("2025-12-15");
    expect(out!.other_weight).toBeCloseTo(0.1, 12);
    expect(out!.holdings.map((h) => h.ticker)).toEqual([T1, T2]);

    const h1 = out!.holdings[0]!;
    expect(h1.price_ticker).toBe(T1);
    expect(h1.weight).toBeCloseTo(0.54, 12);
    for (const [period, anchor] of [
      ["year", YEAR_ANCHOR],
      ["month", MONTH_ANCHOR],
      ["day", DAY_ANCHOR],
    ] as const) {
      expect(h1.pct[period].usd).toBeCloseTo(priceOnOrBefore(T1, TODAY) / priceOnOrBefore(T1, anchor) - 1, 10);
      expect(h1.pct[period].clp).toBeCloseTo(clpValue(T1, TODAY) / clpValue(T1, anchor) - 1, 10);
      expect(h1.contribution_pct[period].usd).toBeCloseTo(contributionUsd(T1, anchor, () => 0.54), 10);
    }
    expect(h1.days_held.year).toEqual({ held: 196, total: 196 });
    expect(h1.days_held.month).toEqual({ held: 15, total: 15 });
    expect(h1.days_held.day).toEqual({ held: 1, total: 1 });

    const h2 = out!.holdings[1]!;
    expect(h2.weight).toBeCloseTo(0.36, 12);
    expect(h2.pct.year.usd).toBeCloseTo(priceOnOrBefore(T2, TODAY) / priceOnOrBefore(T2, YEAR_ANCHOR) - 1, 10);
    expect(h2.contribution_pct.month.usd).toBeCloseTo(contributionUsd(T2, MONTH_ANCHOR, () => 0.36), 10);
  });

  it("includeUsd=false leaves the usd legs null and keeps the clp ones", () => {
    const bucket = `${BUCKET_PREFIX}_all`;
    record(bucket, "2025-12-15", 1, [{ ticker: T1, weight: 1 }]);

    const out = loadProxyBasketBreakdown(bucket, { now: NOW, includeUsd: false })!;
    const h = out.holdings[0]!;
    expect(h.pct.year.usd).toBeNull();
    expect(h.contribution_pct.year.usd).toBeNull();
    expect(h.pct.year.clp).toBeCloseTo(clpValue(T1, TODAY) / clpValue(T1, YEAR_ANCHOR) - 1, 10);
    expect(out.other_weight).toBe(0);
  });

  it("a holding that entered mid-window counts only the days after its first basket", () => {
    const bucket = `${BUCKET_PREFIX}_entered`;
    record(bucket, "2025-12-15", 1, [{ ticker: T1, weight: 1 }]);
    // Stated on a Sunday: in force from Monday 07-06's move on (the day after it).
    record(bucket, "2026-07-05", 1, [
      { ticker: T1, weight: 0.7 },
      { ticker: T2, weight: 0.3 },
    ]);

    const out = loadProxyBasketBreakdown(bucket, { now: NOW, includeUsd: true })!;
    expect(out.positions_date).toBe("2026-07-05");
    const h2 = out.holdings.find((h) => h.ticker === T2)!;
    expect(h2.weight).toBeCloseTo(0.3, 12);
    expect(h2.days_held.year).toEqual({ held: 10, total: 196 });
    expect(h2.days_held.month).toEqual({ held: 10, total: 15 });
    expect(h2.days_held.day).toEqual({ held: 1, total: 1 });
    const entered = priceOnOrBefore(T2, TODAY) / priceOnOrBefore(T2, "2026-07-05") - 1;
    expect(h2.pct.year.usd).toBeCloseTo(entered, 10);
    expect(h2.pct.month.usd).toBeCloseTo(entered, 10);
    expect(h2.contribution_pct.year.usd).toBeCloseTo(
      contributionUsd(T2, YEAR_ANCHOR, (prev) => (prev >= "2026-07-05" ? 0.3 : 0)),
      10
    );

    // The incumbent's pct is the plain return; its contribution steps with the restated weight.
    const h1 = out.holdings.find((h) => h.ticker === T1)!;
    expect(h1.pct.year.usd).toBeCloseTo(priceOnOrBefore(T1, TODAY) / priceOnOrBefore(T1, YEAR_ANCHOR) - 1, 10);
    expect(h1.days_held.year).toEqual({ held: 196, total: 196 });
    expect(h1.contribution_pct.year.usd).toBeCloseTo(
      contributionUsd(T1, YEAR_ANCHOR, (prev) => (prev >= "2026-07-05" ? 0.7 : 1)),
      10
    );
  });

  it("a holding that left and came back chains its two windows; the days out add nothing", () => {
    const bucket = `${BUCKET_PREFIX}_returned`;
    record(bucket, "2025-12-15", 1, [
      { ticker: T1, weight: 0.5 },
      { ticker: T2, weight: 0.5 },
    ]);
    record(bucket, "2026-03-10", 1, [{ ticker: T1, weight: 1 }]);
    record(bucket, "2026-05-20", 1, [
      { ticker: T1, weight: 0.5 },
      { ticker: T2, weight: 0.5 },
    ]);

    const out = loadProxyBasketBreakdown(bucket, { now: NOW, includeUsd: true })!;
    const h2 = out.holdings.find((h) => h.ticker === T2)!;
    // Held through 03-10 (the 03-10 basket governs moves from 03-11) and from 05-21 on.
    expect(h2.days_held.year).toEqual({ held: 69 + 56, total: 196 });
    expect(h2.days_held.month).toEqual({ held: 15, total: 15 });
    const first = priceOnOrBefore(T2, "2026-03-10") / priceOnOrBefore(T2, YEAR_ANCHOR);
    const second = priceOnOrBefore(T2, TODAY) / priceOnOrBefore(T2, "2026-05-20");
    expect(h2.pct.year.usd).toBeCloseTo(first * second - 1, 10);
    expect(h2.pct.year.clp).toBeCloseTo(
      (clpValue(T2, "2026-03-10") / clpValue(T2, YEAR_ANCHOR)) * (clpValue(T2, TODAY) / clpValue(T2, "2026-05-20")) - 1,
      10
    );
    expect(h2.contribution_pct.year.usd).toBeCloseTo(
      contributionUsd(T2, YEAR_ANCHOR, (prev) => (prev < "2026-03-10" || prev >= "2026-05-20" ? 0.5 : 0)),
      10
    );
    // Month and day windows are entirely inside the second holding window.
    expect(h2.pct.month.usd).toBeCloseTo(priceOnOrBefore(T2, TODAY) / priceOnOrBefore(T2, MONTH_ANCHOR) - 1, 10);
  });

  it("throws when the year window starts before the bucket's first stated basket", () => {
    const bucket = `${BUCKET_PREFIX}_late`;
    record(bucket, "2026-03-01", 1, [{ ticker: T1, weight: 1 }]);
    expect(() => loadProxyBasketBreakdown(bucket, { now: NOW, includeUsd: true })).toThrow(
      /first stated basket is 2026-03-01/
    );
  });

  it("throws when the latest basket has no etf_weight_sum", () => {
    const bucket = `${BUCKET_PREFIX}_no_sum`;
    record(bucket, "2025-12-15", null, [{ ticker: T1, weight: 1 }]);
    expect(() => loadProxyBasketBreakdown(bucket, { now: NOW, includeUsd: true })).toThrow(/no etf_weight_sum/);
  });
});
