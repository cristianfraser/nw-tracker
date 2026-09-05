import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  FINTUAL_INFERRED_UNIT_MAX_REL_STEP,
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

describe("recordFintualGoalFundUnitDaily real-day backfill", () => {
  it("writes missed days from recentNavByDay and leaves unpublished days as carry", () => {
    wipeRange("2099-07-01", "2099-07-31");
    seedBar("2099-07-01", 1000, `fintual:real_assets:publish|${NOTES}`);
    try {
      const r = recordFintualGoalFundUnitDaily({
        accountId: -1,
        importNotes: NOTES,
        asOfYmd: "2099-07-04",
        navClp: 100_300,
        fundPriceClp: 1003,
        units: 100,
        recentNavByDay: new Map([
          ["2099-07-02", 1001], // published late — a poll on 07-02 evening missed it
          ["2099-07-04", 1003],
        ]),
        dryRun: false,
      });
      expect(r.recorded).toBe(true);
      expect(r.realDaysBackfilled).toBe(1);
      expect(readBar("2099-07-02")).toMatchObject({
        unit_value_clp: 1001,
        note: `fintual:real_assets:publish|${NOTES}`,
      });
      // 07-03 is not in the API series → carry of the last real bar.
      expect(readBar("2099-07-03")).toMatchObject({
        unit_value_clp: 1001,
        note: "fintual:carry-forward",
      });
      expect(readBar("2099-07-04")).toMatchObject({
        unit_value_clp: 1003,
        note: `fintual:real_assets:publish|${NOTES}`,
      });

      // Re-running is a no-op: publish bars are never re-backfilled.
      const again = recordFintualGoalFundUnitDaily({
        accountId: -1,
        importNotes: NOTES,
        asOfYmd: "2099-07-04",
        navClp: 100_300,
        fundPriceClp: 1003,
        units: 100,
        recentNavByDay: new Map([["2099-07-02", 999]]),
        dryRun: false,
      });
      expect(again.realDaysBackfilled).toBe(0);
      expect(readBar("2099-07-02")!.unit_value_clp).toBe(1001);
    } finally {
      wipeRange("2099-07-01", "2099-07-31");
    }
  });

  it("replaces a carry-forward placeholder with the real published value", () => {
    wipeRange("2099-08-01", "2099-08-31");
    seedBar("2099-08-01", 1000, `fintual:real_assets:publish|${NOTES}`);
    // A later poll carried 08-02 forward before the fund published its real (different) value.
    seedBar("2099-08-02", 1000, "fintual:carry-forward");
    try {
      const r = recordFintualGoalFundUnitDaily({
        accountId: -1,
        importNotes: NOTES,
        asOfYmd: "2099-08-03",
        navClp: 100_200,
        fundPriceClp: 1002,
        units: 100,
        recentNavByDay: new Map([["2099-08-02", 1001.5]]),
        dryRun: false,
      });
      expect(r.realDaysBackfilled).toBe(1);
      expect(readBar("2099-08-02")).toMatchObject({
        unit_value_clp: 1001.5,
        note: `fintual:real_assets:publish|${NOTES}`,
      });
      expect(readBar("2099-08-03")!.unit_value_clp).toBe(1002);
    } finally {
      wipeRange("2099-08-01", "2099-08-31");
    }
  });
});
