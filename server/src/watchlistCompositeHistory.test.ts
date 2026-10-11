import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  compositeTickerChanges,
  latestCompositePositionsBefore,
  listCompositePositionsDates,
  loadCompositePositions,
  recordCompositePositions,
} from "./watchlistCompositeHistory.js";

const BUCKET = "vitest_composite_history_fixture";

afterEach(() => {
  db.prepare(`DELETE FROM watchlist_composite_positions WHERE bucket_slug = ?`).run(BUCKET);
});

describe("recordCompositePositions", () => {
  it("records a basket once, answers unchanged on a repeat and conflict on other weights", () => {
    const first = recordCompositePositions({
      bucket_slug: BUCKET,
      positions_date: "2026-10-01",
      etf_weight_sum: 0.986,
      source: "sync",
      holdings: [
        { ticker: "spym", weight: 0.4 },
        { ticker: "FTEC", weight: 0.35 },
        { ticker: "ESGV", weight: 0.25 },
      ],
    });
    expect(first).toEqual({ status: "inserted" });

    const stored = loadCompositePositions(BUCKET, "2026-10-01");
    expect(stored?.source).toBe("sync");
    expect(stored?.etf_weight_sum).toBe(0.986);
    expect(stored?.holdings).toEqual([
      { ticker: "SPYM", weight: 0.4 },
      { ticker: "FTEC", weight: 0.35 },
      { ticker: "ESGV", weight: 0.25 },
    ]);

    const repeat = recordCompositePositions({
      bucket_slug: BUCKET,
      positions_date: "2026-10-01",
      etf_weight_sum: 0.986,
      source: "snapshot",
      holdings: [
        { ticker: "ESGV", weight: 0.25 },
        { ticker: "FTEC", weight: 0.35 + 1e-12 },
        { ticker: "SPYM", weight: 0.4 },
      ],
    });
    expect(repeat).toEqual({ status: "unchanged" });

    const restated = recordCompositePositions({
      bucket_slug: BUCKET,
      positions_date: "2026-10-01",
      etf_weight_sum: 0.986,
      source: "sync",
      holdings: [
        { ticker: "SPYM", weight: 0.4 },
        { ticker: "FTEC", weight: 0.6 },
      ],
    });
    expect(restated).toEqual({
      status: "conflict",
      differences: [
        { ticker: "ESGV", stored: 0.25, stated: null },
        { ticker: "FTEC", stored: 0.35, stated: 0.6 },
      ],
    });
    // The first statement stays.
    expect(loadCompositePositions(BUCKET, "2026-10-01")?.holdings.map((h) => h.ticker)).toEqual([
      "SPYM",
      "FTEC",
      "ESGV",
    ]);
  });

  it("refuses an empty basket, a repeated ticker and a malformed date", () => {
    const base = { bucket_slug: BUCKET, etf_weight_sum: null, source: "sync" as const };
    expect(() => recordCompositePositions({ ...base, positions_date: "2026-10-01", holdings: [] })).toThrow(
      /no holdings/
    );
    expect(() =>
      recordCompositePositions({
        ...base,
        positions_date: "2026-10-01",
        holdings: [
          { ticker: "SPY", weight: 0.5 },
          { ticker: "spy", weight: 0.5 },
        ],
      })
    ).toThrow(/repeated/);
    expect(() =>
      recordCompositePositions({ ...base, positions_date: "01/10/2026", holdings: [{ ticker: "SPY", weight: 1 }] })
    ).toThrow(/positions date/);
    expect(listCompositePositionsDates(BUCKET)).toEqual([]);
  });

  it("finds the latest recorded basket before a date and names what entered and left", () => {
    const write = (date: string, holdings: { ticker: string; weight: number }[]) =>
      recordCompositePositions({ bucket_slug: BUCKET, positions_date: date, etf_weight_sum: null, source: "snapshot", holdings });
    write("2026-09-30", [
      { ticker: "ESGV", weight: 0.5 },
      { ticker: "SPYM", weight: 0.5 },
    ]);
    write("2026-10-02", [
      { ticker: "SPYM", weight: 0.5 },
      { ticker: "AVDV", weight: 0.5 },
    ]);
    expect(listCompositePositionsDates(BUCKET)).toEqual(["2026-09-30", "2026-10-02"]);
    expect(latestCompositePositionsBefore(BUCKET, "2026-09-30")).toBeNull();
    expect(latestCompositePositionsBefore(BUCKET, "2026-10-01")?.positions_date).toBe("2026-09-30");
    const previous = latestCompositePositionsBefore(BUCKET, "2026-10-05");
    expect(previous?.positions_date).toBe("2026-10-02");

    expect(
      compositeTickerChanges(latestCompositePositionsBefore(BUCKET, "2026-10-02")!.holdings, previous!.holdings)
    ).toEqual({ entered: ["AVDV"], left: ["ESGV"] });
    expect(compositeTickerChanges(null, previous!.holdings)).toEqual({ entered: ["AVDV", "SPYM"], left: [] });
  });
});
