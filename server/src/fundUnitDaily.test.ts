import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { upsertFundUnitSpotPreservingHistory } from "./fundUnitDaily.js";

const SERIES = "vitest_fund_unit_daily_gapfill";

function seedBar(day: string, px: number, note: string): void {
  db.prepare(`INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note) VALUES (?, ?, ?, ?)`).run(
    SERIES,
    day,
    px,
    note
  );
}

function readBar(day: string): { unit_value_clp: number; note: string } | undefined {
  return db
    .prepare(`SELECT unit_value_clp, note FROM fund_unit_daily WHERE series_key = ? AND day = ?`)
    .get(SERIES, day) as { unit_value_clp: number; note: string } | undefined;
}

afterEach(() => {
  db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ?`).run(SERIES);
});

describe("upsertFundUnitSpotPreservingHistory gap fill", () => {
  it("carry_previous (default) fills the gap with the previous value", () => {
    seedBar("2099-05-01", 1000, "seed");
    const r = upsertFundUnitSpotPreservingHistory({
      seriesKey: SERIES,
      observationDay: "2099-05-04",
      unitValueClp: 1003,
      note: "obs",
      carryNote: "vitest-carry",
      dryRun: false,
    });
    expect(r.gapDaysFilled).toBe(2);
    expect(readBar("2099-05-02")).toMatchObject({ unit_value_clp: 1000, note: "vitest-carry" });
    expect(readBar("2099-05-03")).toMatchObject({ unit_value_clp: 1000, note: "vitest-carry" });
    expect(readBar("2099-05-04")).toMatchObject({ unit_value_clp: 1003, note: "obs" });
  });

  it("carry_previous leaves the gap empty when the value did not move", () => {
    seedBar("2099-05-01", 1000, "seed");
    const r = upsertFundUnitSpotPreservingHistory({
      seriesKey: SERIES,
      observationDay: "2099-05-04",
      unitValueClp: 1000,
      note: "obs",
      dryRun: false,
    });
    expect(r.gapDaysFilled).toBe(0);
    expect(readBar("2099-05-02")).toBeUndefined();
  });

  it("stand_in_new fills the gap with the new value under the stand-in note, even for an equal value", () => {
    seedBar("2099-05-01", 1000, "seed");
    const r = upsertFundUnitSpotPreservingHistory({
      seriesKey: SERIES,
      observationDay: "2099-05-04",
      unitValueClp: 999.5,
      note: "obs",
      gapFill: "stand_in_new",
      standInNote: "vitest-stand-in",
      dryRun: false,
    });
    expect(r.gapDaysFilled).toBe(2);
    expect(readBar("2099-05-01")).toMatchObject({ unit_value_clp: 1000, note: "seed" });
    expect(readBar("2099-05-02")).toMatchObject({ unit_value_clp: 999.5, note: "vitest-stand-in" });
    expect(readBar("2099-05-03")).toMatchObject({ unit_value_clp: 999.5, note: "vitest-stand-in" });
    expect(readBar("2099-05-04")).toMatchObject({ unit_value_clp: 999.5, note: "obs" });

    seedBar("2099-06-01", 1000, "seed");
    const equal = upsertFundUnitSpotPreservingHistory({
      seriesKey: SERIES,
      observationDay: "2099-06-03",
      unitValueClp: 1000,
      note: "obs",
      gapFill: "stand_in_new",
      standInNote: "vitest-stand-in",
      dryRun: false,
    });
    expect(equal.gapDaysFilled).toBe(1);
    expect(readBar("2099-06-02")).toMatchObject({ unit_value_clp: 1000, note: "vitest-stand-in" });
  });

  it("stand_in_new needs a stand-in note and writes nothing on a dry run", () => {
    seedBar("2099-05-01", 1000, "seed");
    expect(() =>
      upsertFundUnitSpotPreservingHistory({
        seriesKey: SERIES,
        observationDay: "2099-05-04",
        unitValueClp: 1001,
        note: "obs",
        gapFill: "stand_in_new",
        dryRun: false,
      })
    ).toThrow(/standInNote/);
    const dry = upsertFundUnitSpotPreservingHistory({
      seriesKey: SERIES,
      observationDay: "2099-05-04",
      unitValueClp: 1001,
      note: "obs",
      gapFill: "stand_in_new",
      standInNote: "vitest-stand-in",
      dryRun: true,
    });
    expect(dry.gapDaysFilled).toBe(2);
    expect(readBar("2099-05-02")).toBeUndefined();
    expect(readBar("2099-05-04")).toBeUndefined();
  });

  it("does not fill when there is no earlier bar or no gap", () => {
    const first = upsertFundUnitSpotPreservingHistory({
      seriesKey: SERIES,
      observationDay: "2099-05-04",
      unitValueClp: 1001,
      note: "obs",
      gapFill: "stand_in_new",
      standInNote: "vitest-stand-in",
      dryRun: false,
    });
    expect(first.gapDaysFilled).toBe(0);
    const next = upsertFundUnitSpotPreservingHistory({
      seriesKey: SERIES,
      observationDay: "2099-05-05",
      unitValueClp: 1002,
      note: "obs",
      gapFill: "stand_in_new",
      standInNote: "vitest-stand-in",
      dryRun: false,
    });
    expect(next.gapDaysFilled).toBe(0);
  });
});
