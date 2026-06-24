import { describe, expect, it } from "vitest";
import { chileCalendarAddDays } from "./chileDate.js";
import type { GlobalSyncStateFile } from "./globalSyncState.js";
import { isFintualRnCompositionStale } from "./globalSyncStale.js";
import {
  COMPOSITION_STALE_DAYS,
  parseManagedFundPositionsBody,
} from "./fintualRiskyNorrisComposition.js";

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

describe("isFintualRnCompositionStale", () => {
  const cl = { ymd: "2026-06-23" } as import("./chileDate.js").ChileWallClock;

  it("is stale when last sync is missing", () => {
    expect(isFintualRnCompositionStale(cl, {})).toBe(true);
  });

  it("is stale when last sync is older than 30 days", () => {
    const last = chileCalendarAddDays(cl.ymd, -(COMPOSITION_STALE_DAYS + 1));
    const state: GlobalSyncStateFile = { fintualRnCompositionLastSyncYmd: last };
    expect(isFintualRnCompositionStale(cl, state)).toBe(true);
  });

  it("is fresh within 30 days", () => {
    const last = chileCalendarAddDays(cl.ymd, -5);
    const state: GlobalSyncStateFile = { fintualRnCompositionLastSyncYmd: last };
    expect(isFintualRnCompositionStale(cl, state)).toBe(false);
  });
});
