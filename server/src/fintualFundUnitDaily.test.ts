import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  FINTUAL_INFERRED_UNIT_MAX_REL_STEP,
  isFintualCarryForwardFundUnitNote,
  isFintualPublishedFundUnitNote,
  recordFintualGoalFundUnitDaily,
  resolveFintualUnitClp,
} from "./fintualFundUnitDaily.js";

const SERIES = "fintual_cert_apv_a";
const NOTES = "import:fintual|cert|key=apv_a";

function seedBar(day: string, px: number, note: string): void {
  db.prepare(
    `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note) VALUES (?, ?, ?, ?)
     ON CONFLICT(series_key, day) DO UPDATE SET unit_value_clp = excluded.unit_value_clp, note = excluded.note`
  ).run(SERIES, day, px, note);
}

function readBar(day: string): { unit_value_clp: number; note: string } | undefined {
  return db
    .prepare(`SELECT unit_value_clp, note FROM fund_unit_daily WHERE series_key = ? AND day = ?`)
    .get(SERIES, day) as { unit_value_clp: number; note: string } | undefined;
}

function wipeRange(fromYmd: string, toYmd: string): void {
  db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ? AND day >= ? AND day <= ?`).run(
    SERIES,
    fromYmd,
    toYmd
  );
}

describe("resolveFintualUnitClp band guard", () => {
  it("refuses an inferred cuota far from the last bar (pending-retiro NAV)", () => {
    wipeRange("2099-06-01", "2099-06-30");
    seedBar("2099-06-01", 1000, "vitest-band");
    try {
      // NAV net of a pending 26% withdrawal would bootstrap a wildly wrong cuota → refuse.
      expect(
        resolveFintualUnitClp({
          accountId: -1,
          seriesKey: SERIES,
          navClp: 74_000,
          asOfYmd: "2099-06-02",
          fundPriceClp: null,
          units: 100,
        })
      ).toBeNull();
      // A small drift bootstraps fine.
      expect(
        resolveFintualUnitClp({
          accountId: -1,
          seriesKey: SERIES,
          navClp: 99_000,
          asOfYmd: "2099-06-02",
          fundPriceClp: null,
          units: 100,
        })
      ).toBe(990);
      // A real publish price is never banded (the publish IS the truth).
      const bigStep = 1000 * (1 + 2 * FINTUAL_INFERRED_UNIT_MAX_REL_STEP);
      expect(
        resolveFintualUnitClp({
          accountId: -1,
          seriesKey: SERIES,
          navClp: 0,
          asOfYmd: "2099-06-02",
          fundPriceClp: bigStep,
          units: 100,
        })
      ).toBe(Math.round(bigStep * 10000) / 10000);
    } finally {
      wipeRange("2099-06-01", "2099-06-30");
    }
  });
});

describe("fund unit note provenance", () => {
  it("recognises published bars from every source and carry placeholders", () => {
    expect(isFintualPublishedFundUnitNote("fintual:real_assets:publish|import:fintual|cert|key=apv_a")).toBe(true);
    expect(isFintualPublishedFundUnitNote("fintual:gql:shares-publish|import:fintual|cert|key=apv_a")).toBe(true);
    expect(isFintualPublishedFundUnitNote("fintual:public-serie:publish|serie=7")).toBe(true);
    expect(isFintualPublishedFundUnitNote("fintual:api:goal-nav|x")).toBe(false);
    expect(isFintualPublishedFundUnitNote("fintual:carry-forward")).toBe(false);
    expect(isFintualPublishedFundUnitNote(null)).toBe(false);
    expect(isFintualCarryForwardFundUnitNote("fintual:carry-forward")).toBe(true);
    expect(isFintualCarryForwardFundUnitNote("fintual:cert-carry-forward")).toBe(true);
    expect(isFintualCarryForwardFundUnitNote("fintual:gql:shares-publish|x")).toBe(false);
  });
});

describe("recordFintualGoalFundUnitDaily", () => {
  it("writes the publish-day bar with the shares-publish note, carries the gap, restates on re-poll", () => {
    wipeRange("2099-07-01", "2099-07-31");
    seedBar("2099-07-01", 1000, `fintual:gql:shares-publish|${NOTES}`);
    try {
      const r = recordFintualGoalFundUnitDaily({
        accountId: -1,
        importNotes: NOTES,
        asOfYmd: "2099-07-04",
        navClp: 100_300,
        fundPriceClp: 1003,
        units: 100,
        dryRun: false,
      });
      expect(r).toEqual({ recorded: true, unitClp: 1003, gapDaysFilled: 2 });
      expect(readBar("2099-07-02")).toMatchObject({ unit_value_clp: 1000, note: "fintual:carry-forward" });
      expect(readBar("2099-07-03")).toMatchObject({ unit_value_clp: 1000, note: "fintual:carry-forward" });
      expect(readBar("2099-07-04")).toMatchObject({
        unit_value_clp: 1003,
        note: `fintual:gql:shares-publish|${NOTES}`,
      });
      // The publish day itself is restated by a later poll (Fintual revised the closure).
      recordFintualGoalFundUnitDaily({
        accountId: -1,
        importNotes: NOTES,
        asOfYmd: "2099-07-04",
        navClp: 100_350,
        fundPriceClp: 1003.5,
        units: 100,
        dryRun: false,
      });
      expect(readBar("2099-07-04")!.unit_value_clp).toBe(1003.5);
    } finally {
      wipeRange("2099-07-01", "2099-07-31");
    }
  });
});
