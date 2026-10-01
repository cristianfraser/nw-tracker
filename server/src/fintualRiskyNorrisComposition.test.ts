import { describe, expect, it } from "vitest";
import type { ChileWallClock } from "./chileDate.js";
import type { GlobalSyncStateFile } from "./globalSyncState.js";
import { isFintualRnCompositionStale } from "./globalSyncStale.js";
import { holdingsForPricing, parseManagedFundPositionsBody } from "./fintualRiskyNorrisComposition.js";
import { isFintualRnCompositionDueDay } from "./syncSourceSchedule.js";

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

  it("allows the future_contract_positions sleeve Fintual added 2026-09 (empty or not)", () => {
    const parsed = parseManagedFundPositionsBody({
      date: "2026-09-03",
      etf_positions: FIXTURE.etf_positions,
      fund_positions: [{ weight: 0.01, fund: { asset: { ticker: "CASH" } } }],
      bond_positions: [],
      future_contract_positions: [],
    });
    expect(parsed.date).toBe("2026-09-03");
    expect(parsed.etf_positions).toHaveLength(2);
  });

  it("accepts an empty fx forward sleeve and throws on a filled one", () => {
    const base = { date: "2026-09-29", etf_positions: FIXTURE.etf_positions, fund_positions: [] };
    expect(parseManagedFundPositionsBody({ ...base, fx_forward_contract_positions: [] }).date).toBe("2026-09-29");
    expect(() =>
      parseManagedFundPositionsBody({ ...base, fx_forward_contract_positions: [{ weight: 0.1 }] })
    ).toThrow(/not empty/);
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
  // 2026-06-23 is a Tuesday (Chile business day); 2026-06-20 is a Saturday, 2026-06-21 a Sunday.
  const businessDay = (hour: number, minute = 0): ChileWallClock => ({
    ymd: "2026-06-23",
    year: 2026,
    month: 6,
    day: 23,
    hour,
    minute,
    monthKey: "2026-06",
  });
  const weekendDay = (day: 20 | 21, hour: number, minute = 0): ChileWallClock => ({
    ymd: `2026-06-${day}`,
    year: 2026,
    month: 6,
    day,
    hour,
    minute,
    monthKey: "2026-06",
  });

  it("is not stale before 18:30 on a business day", () => {
    expect(isFintualRnCompositionStale(businessDay(9, 59), {})).toBe(false);
    expect(isFintualRnCompositionStale(businessDay(18, 29), {})).toBe(false);
  });

  it("is stale from 18:30 when not yet synced today", () => {
    expect(isFintualRnCompositionStale(businessDay(18, 30), {})).toBe(true);
    const staleState: GlobalSyncStateFile = { fintualRnCompositionLastSyncYmd: "2026-06-22" };
    expect(isFintualRnCompositionStale(businessDay(18, 30), staleState)).toBe(true);
  });

  it("is fresh once today's composition sync ran", () => {
    const state: GlobalSyncStateFile = { fintualRnCompositionLastSyncYmd: "2026-06-23" };
    expect(isFintualRnCompositionStale(businessDay(19), state)).toBe(false);
  });

  it("a Saturday is due from 18:30 (Friday's cuota publishes on Saturday); a Sunday never is", () => {
    expect(isFintualRnCompositionStale(weekendDay(20, 11), {})).toBe(false);
    expect(isFintualRnCompositionStale(weekendDay(20, 18, 30), {})).toBe(true);
    expect(isFintualRnCompositionStale(weekendDay(21, 18, 30), {})).toBe(false);
  });
});

describe("isFintualRnCompositionDueDay", () => {
  it("is a Chile business day or the day after one", () => {
    expect(isFintualRnCompositionDueDay("2026-06-23")).toBe(true); // Tuesday
    expect(isFintualRnCompositionDueDay("2026-06-20")).toBe(true); // Saturday after a business Friday
    expect(isFintualRnCompositionDueDay("2026-06-21")).toBe(false); // Sunday
  });

  it("a holiday Friday is due (Thursday published), the Saturday after it is not", () => {
    // 2026-09-18 is Fiestas Patrias (Chile closed, NYSE open).
    expect(isFintualRnCompositionDueDay("2026-09-18")).toBe(true);
    expect(isFintualRnCompositionDueDay("2026-09-19")).toBe(false);
    expect(isFintualRnCompositionDueDay("2026-09-20")).toBe(false);
    expect(isFintualRnCompositionDueDay("2026-09-21")).toBe(true);
  });
});
