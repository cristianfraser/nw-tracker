import { describe, expect, it } from "vitest";
import type { ChileWallClock } from "./chileDate.js";
import type { GlobalSyncStateFile } from "./globalSyncState.js";
import { isFintualRnCompositionStale } from "./globalSyncStale.js";
import { holdingsAsStated, holdingsForPricing, parseManagedFundPositionsBody } from "./fintualRiskyNorrisComposition.js";
import { isFintualRnCompositionDueDay, rnCompositionNextSync } from "./syncSourceSchedule.js";

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

describe("holdingsAsStated", () => {
  it("keeps Fintual's own tickers for the history: SPXS stays SPXS, nothing is merged", () => {
    const positions = [
      { weight: 0.6, etf: { asset: { ticker: "SPYM" } } },
      { weight: 0.3, etf: { asset: { ticker: "SPXS" } } },
      { weight: 0.1, etf: { asset: { ticker: "IAUM" } } },
    ];
    expect(holdingsAsStated(positions)).toEqual([
      { ticker: "SPYM", weight: 0.6 },
      { ticker: "SPXS", weight: 0.3 },
      { ticker: "IAUM", weight: 0.1 },
    ]);
    expect(holdingsForPricing(positions, "2026-10-08").map((h) => h.ticker)).toEqual(["SPYM", "SPY", "IAUM"]);
    expect(() =>
      holdingsAsStated([
        { weight: 0.5, etf: { asset: { ticker: "SPXS" } } },
        { weight: 0.5, etf: { asset: { ticker: "SPXS" } } },
      ])
    ).toThrow(/listed twice/);
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

  it("is not stale before the day's first slot", () => {
    expect(isFintualRnCompositionStale(businessDay(9, 59), {})).toBe(false);
  });

  it("each slot is due once: stale from the slot until a run stamps it", () => {
    expect(isFintualRnCompositionStale(businessDay(10, 0), {})).toBe(true);
    const ranAt10: GlobalSyncStateFile = { fintualRnCompositionLastSlot: "2026-06-23 10:00" };
    expect(isFintualRnCompositionStale(businessDay(11, 59), ranAt10)).toBe(false);
    expect(isFintualRnCompositionStale(businessDay(12, 0), ranAt10)).toBe(true);
    expect(isFintualRnCompositionStale(businessDay(18, 29), { fintualRnCompositionLastSlot: "2026-06-23 15:00" })).toBe(false);
    expect(isFintualRnCompositionStale(businessDay(18, 30), { fintualRnCompositionLastSlot: "2026-06-23 15:00" })).toBe(true);
    expect(isFintualRnCompositionStale(businessDay(23), { fintualRnCompositionLastSlot: "2026-06-23 18:30" })).toBe(false);
  });

  it("a missed slot is one run, not several: only the slot in force counts", () => {
    const ranYesterday: GlobalSyncStateFile = { fintualRnCompositionLastSlot: "2026-06-22 18:30" };
    expect(isFintualRnCompositionStale(businessDay(16), ranYesterday)).toBe(true);
    expect(isFintualRnCompositionStale(businessDay(16), { fintualRnCompositionLastSlot: "2026-06-23 15:00" })).toBe(false);
  });

  it("a Saturday is due (Friday's cuota publishes on Saturday); a Sunday never is", () => {
    expect(isFintualRnCompositionStale(weekendDay(20, 9), {})).toBe(false);
    expect(isFintualRnCompositionStale(weekendDay(20, 12), {})).toBe(true);
    expect(isFintualRnCompositionStale(weekendDay(21, 18, 30), {})).toBe(false);
  });
});

describe("rnCompositionNextSync", () => {
  const at = (ymd: string, hour: number, minute = 0): ChileWallClock => {
    const [year, month, day] = ymd.split("-").map(Number) as [number, number, number];
    return { ymd, year, month, day, hour, minute, monthKey: ymd.slice(0, 7) };
  };
  const wall = (t: ReturnType<typeof rnCompositionNextSync>) => (t ? `${t.ymd} ${t.hour}:${t.minute}` : null);

  it("wakes at the next slot today, then the next due day's first slot", () => {
    expect(wall(rnCompositionNextSync(at("2026-06-23", 8), {}))).toBe("2026-06-23 10:0");
    const ran12: GlobalSyncStateFile = { fintualRnCompositionLastSlot: "2026-06-23 12:00" };
    expect(wall(rnCompositionNextSync(at("2026-06-23", 13), ran12))).toBe("2026-06-23 15:0");
    const ran1830: GlobalSyncStateFile = { fintualRnCompositionLastSlot: "2026-06-23 18:30" };
    expect(wall(rnCompositionNextSync(at("2026-06-23", 19), ran1830))).toBe("2026-06-24 10:0");
    // Saturday's last slot ran: Sunday is not due, Monday is.
    const ranSat: GlobalSyncStateFile = { fintualRnCompositionLastSlot: "2026-06-20 18:30" };
    expect(wall(rnCompositionNextSync(at("2026-06-20", 20), ranSat))).toBe("2026-06-22 10:0");
  });

  it("an unrun slot in force is due now", () => {
    expect(wall(rnCompositionNextSync(at("2026-06-23", 13, 7), {}))).toBe("2026-06-23 13:7");
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
