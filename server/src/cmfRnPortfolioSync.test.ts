import { afterEach, describe, expect, it } from "vitest";
import type { ChileWallClock } from "./chileDate.js";
import {
  CMF_RN_CROSS_CHECK_WEIGHT_ALARM,
  cmfExpectedPeriod,
  cmfNextPeriod,
  cmfRnNextDueYmd,
  crossCheckCmfBasket,
  isCmfRnPortfolioStale,
} from "./cmfRnPortfolioSync.js";
import { db } from "./db.js";
import { recordCompositePositions } from "./watchlistCompositeHistory.js";

function clock(ymd: string, hour: number): ChileWallClock {
  const [y, m, d] = ymd.split("-").map(Number);
  return { ymd, year: y, month: m, day: d, hour, minute: 0, weekday: 1 } as unknown as ChileWallClock;
}

describe("CMF Risky Norris portfolio: due rule", () => {
  it("expects the previous calendar month, across the year boundary too", () => {
    expect(cmfExpectedPeriod(clock("2026-10-11", 12))).toBe("202609");
    expect(cmfExpectedPeriod(clock("2026-01-03", 12))).toBe("202512");
    expect(cmfNextPeriod("202512")).toBe("202601");
    expect(cmfNextPeriod("202609")).toBe("202610");
  });

  it("is stale from 09:00 while the expected month is not on record, once a day", () => {
    const state = { cmfRnPortfolioLastMonth: "202608" };
    expect(isCmfRnPortfolioStale(clock("2026-10-11", 8), state)).toBe(false);
    expect(isCmfRnPortfolioStale(clock("2026-10-11", 9), state)).toBe(true);
    expect(isCmfRnPortfolioStale(clock("2026-10-11", 20), { ...state, cmfRnPortfolioLastCheckYmd: "2026-10-11" })).toBe(false);
    expect(isCmfRnPortfolioStale(clock("2026-10-12", 9), { ...state, cmfRnPortfolioLastCheckYmd: "2026-10-11" })).toBe(true);
    expect(isCmfRnPortfolioStale(clock("2026-10-11", 12), { cmfRnPortfolioLastMonth: "202609" })).toBe(false);
  });

  it("names the next due day: today before 09:00, tomorrow after an attempt, the 1st when caught up", () => {
    const pending = { cmfRnPortfolioLastMonth: "202608" };
    expect(cmfRnNextDueYmd(clock("2026-10-11", 7), pending)).toBe("2026-10-11");
    expect(cmfRnNextDueYmd(clock("2026-10-11", 10), { ...pending, cmfRnPortfolioLastCheckYmd: "2026-10-11" })).toBe("2026-10-12");
    expect(cmfRnNextDueYmd(clock("2026-10-11", 10), { cmfRnPortfolioLastMonth: "202609" })).toBe("2026-11-01");
    expect(cmfRnNextDueYmd(clock("2026-12-05", 10), { cmfRnPortfolioLastMonth: "202611" })).toBe("2027-01-01");
  });
});

const BUCKET = "vitest_cmf_cross_check_fixture";
afterEach(() => {
  db.prepare(`DELETE FROM watchlist_composite_positions WHERE bucket_slug = ?`).run(BUCKET);
});

describe("crossCheckCmfBasket", () => {
  it("compares with the latest Fintual basket inside the fortnight and alarms on a ticker difference or a wide gap", () => {
    recordCompositePositions({
      bucket_slug: BUCKET,
      positions_date: "2026-09-21",
      etf_weight_sum: 0.98,
      source: "snapshot",
      holdings: [
        { ticker: "FTEC", weight: 0.6 },
        { ticker: "SPXS", weight: 0.4 },
      ],
    });
    const same = crossCheckCmfBasket(
      "2026-09-30",
      [
        { ticker: "FTEC", weight: 0.61 },
        { ticker: "SPXS", weight: 0.39 },
      ],
      BUCKET
    );
    expect(same.fintual_positions_date).toBe("2026-09-21");
    expect(same.fintual_source).toBe("snapshot");
    expect(same.entered).toEqual([]);
    expect(same.left).toEqual([]);
    expect(same.max_weight_gap).toBeCloseTo(0.01, 10);
    expect(same.alarm).toBe(false);

    const wide = crossCheckCmfBasket(
      "2026-09-30",
      [
        { ticker: "FTEC", weight: 0.6 + CMF_RN_CROSS_CHECK_WEIGHT_ALARM + 0.001 },
        { ticker: "SPXS", weight: 0.4 - CMF_RN_CROSS_CHECK_WEIGHT_ALARM - 0.001 },
      ],
      BUCKET
    );
    expect(wide.alarm).toBe(true);

    const changed = crossCheckCmfBasket(
      "2026-09-30",
      [
        { ticker: "FTEC", weight: 0.6 },
        { ticker: "SPYM", weight: 0.4 },
      ],
      BUCKET
    );
    expect(changed.entered).toEqual(["SPYM"]);
    expect(changed.left).toEqual(["SPXS"]);
    expect(changed.alarm).toBe(true);

    // A Fintual basket older than the window is not comparable.
    const far = crossCheckCmfBasket("2026-10-31", [{ ticker: "FTEC", weight: 1 }], BUCKET);
    expect(far.fintual_positions_date).toBeNull();
    expect(far.alarm).toBe(false);
  });
});
