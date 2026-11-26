import { afterAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { fundUnitRowOnOrBeforeForDisplay, upsertFundUnitSpotPreservingHistory } from "./fundUnitDaily.js";

const SERIES = "vitest_cert_scratch_series";

afterAll(() => {
  db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ?`).run(SERIES);
});

function insert(day: string, unitValue: number, scratch: 0 | 1): void {
  db.prepare(
    `INSERT INTO fund_unit_daily (series_key, day, unit_value, currency, note, cert_scratch) VALUES (?, ?, ?, 'clp', 'vitest', ?)`
  ).run(SERIES, day, unitValue, scratch);
}

describe("fund unit display rows and certificate scratch prices", () => {
  it("skips scratch rows and reads null when only scratch rows are on or before the day", () => {
    insert("2025-01-02", 100, 1);
    insert("2025-01-03", 101, 1);
    expect(fundUnitRowOnOrBeforeForDisplay(SERIES, "2025-01-03")).toBeNull();
    insert("2025-01-01", 99, 0);
    expect(fundUnitRowOnOrBeforeForDisplay(SERIES, "2025-01-03")).toEqual({ day: "2025-01-01", unit_value: 99, currency: "clp" });
  });

  it("a published value written over a scratch row makes it a display row", () => {
    upsertFundUnitSpotPreservingHistory({
      seriesKey: SERIES,
      observationDay: "2025-01-03",
      unitValueClp: 102,
      note: "vitest-published",
      carryNote: "vitest-carry",
      dryRun: false,
    });
    expect(fundUnitRowOnOrBeforeForDisplay(SERIES, "2025-01-03")).toEqual({ day: "2025-01-03", unit_value: 102, currency: "clp" });
  });
});
