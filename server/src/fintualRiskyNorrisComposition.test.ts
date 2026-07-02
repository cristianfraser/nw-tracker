import { describe, expect, it } from "vitest";
import type { ChileWallClock } from "./chileDate.js";
import type { GlobalSyncStateFile } from "./globalSyncState.js";
import { isFintualRnCompositionStale } from "./globalSyncStale.js";
import { holdingsForPricing, parseManagedFundPositionsBody } from "./fintualRiskyNorrisComposition.js";

const FIXTURE = {
  date: "2026-06-22",
  etf_positions: [
    {
      weight: 0.5,
      etf: { asset: { ticker: "SPY" } },
    },
    {
      weight: 0.5,
      etf: { asset: { ticker: "VEA" } },
    },
  ],
};

describe("parseManagedFundPositionsBody", () => {
  it("parses valid etf_positions and normalizes tickers", () => {
    const parsed = parseManagedFundPositionsBody(FIXTURE);
    expect(parsed.date).toBe("2026-06-22");
    expect(parsed.etf_positions).toHaveLength(2);
    expect(parsed.etf_positions[0]!.etf.asset.ticker).toBe("SPY");
  });

  it("throws when etf weight sum is out of range", () => {
    expect(() =>
      parseManagedFundPositionsBody({
        date: "2026-06-22",
        etf_positions: [{ weight: 0.3, etf: { asset: { ticker: "SPY" } } }],
      })
    ).toThrow(/etf weight sum/i);
  });

  it("allows fund_positions and normalizes etf weights", () => {
    const parsed = parseManagedFundPositionsBody({
      date: "2026-06-22",
      etf_positions: FIXTURE.etf_positions,
      fund_positions: [{ weight: 0.01, fund: { asset: { ticker: "CASH" } } }],
    });
    const sum = parsed.etf_positions.reduce((s, p) => s + p.weight, 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(parsed.raw_etf_weight_sum).toBeCloseTo(1, 6);
  });

  it("throws on unexpected top-level fields", () => {
    expect(() =>
      parseManagedFundPositionsBody({
        date: "2026-06-22",
        cash_positions: [],
        etf_positions: FIXTURE.etf_positions,
      })
    ).toThrow(/unexpected field/i);
  });
});

describe("holdingsForPricing", () => {
  it("maps Fintual SPXS (Invesco S&P 500 UCITS) to SPY, not Yahoo's Direxion bear ETF", () => {
    const holdings = holdingsForPricing(
      [
        { weight: 0.9, etf: { asset: { ticker: "QQQM" } } },
        { weight: 0.1, etf: { asset: { ticker: "SPXS" } } },
      ],
      "2026-06-30"
    );
    expect(holdings).toEqual([
      { ticker: "QQQM", weight: 0.9, synced_at: "2026-06-30" },
      { ticker: "SPY", weight: 0.1, synced_at: "2026-06-30" },
    ]);
  });

  it("merges weights when a mapped ticker collides with a direct holding", () => {
    const holdings = holdingsForPricing(
      [
        { weight: 0.9, etf: { asset: { ticker: "SPY" } } },
        { weight: 0.1, etf: { asset: { ticker: "SPXS" } } },
      ],
      "2026-06-30"
    );
    expect(holdings).toEqual([{ ticker: "SPY", weight: 1, synced_at: "2026-06-30" }]);
  });
});

describe("isFintualRnCompositionStale", () => {
  // 2026-06-23 is a Tuesday (Chile business day); 2026-06-20 is a Saturday.
  const businessDay = (hour: number, minute = 0): ChileWallClock => ({
    ymd: "2026-06-23",
    year: 2026,
    month: 6,
    day: 23,
    hour,
    minute,
    monthKey: "2026-06",
  });
  const weekend = (hour: number): ChileWallClock => ({
    ymd: "2026-06-20",
    year: 2026,
    month: 6,
    day: 20,
    hour,
    minute: 0,
    monthKey: "2026-06",
  });

  it("is not stale on a weekend", () => {
    expect(isFintualRnCompositionStale(weekend(11), {})).toBe(false);
  });

  it("is not stale before 10:00 on a business day", () => {
    expect(isFintualRnCompositionStale(businessDay(9, 59), {})).toBe(false);
  });

  it("is stale from 10:00 when not yet synced today", () => {
    expect(isFintualRnCompositionStale(businessDay(10, 0), {})).toBe(true);
    const staleState: GlobalSyncStateFile = { fintualRnCompositionLastSyncYmd: "2026-06-22" };
    expect(isFintualRnCompositionStale(businessDay(10, 0), staleState)).toBe(true);
  });

  it("is fresh once today's composition sync ran", () => {
    const state: GlobalSyncStateFile = { fintualRnCompositionLastSyncYmd: "2026-06-23" };
    expect(isFintualRnCompositionStale(businessDay(14), state)).toBe(false);
  });
});
