import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  accountChartInactive,
  accountIdForInactiveCheck,
  navBucketChartInactive,
} from "./accountChartInactive.js";
import { isSupersededSantanderCcMaster } from "./ccConsolidatedCards.js";

describe("accountChartInactive", () => {
  it("detects superseded Santander masters excluded from nav", () => {
    const row = db
      .prepare(
        `SELECT id FROM accounts
         WHERE notes IN ('credit_card_master|santander|4111', 'credit_card_master|santander|4112')
         LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;
    expect(isSupersededSantanderCcMaster(row.id)).toBe(true);
  });

  it("CC masters are used directly for inactivity (no liability_view duplicate)", () => {
    const row = db
      .prepare(
        `SELECT id FROM accounts
         WHERE notes = 'credit_card_master|santander|4242'
         LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;
    expect(accountIdForInactiveCheck(row.id)).toBe(row.id);
    expect(accountChartInactive(row.id)).toBe(false);
  });

  it("navBucketChartInactive mirrors per-account inactivity", () => {
    expect(navBucketChartInactive([])).toBe(true);
    const active = db
      .prepare(
        `SELECT id FROM accounts
         WHERE notes = 'credit_card_master|santander|4242'
         LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!active) return;
    expect(accountChartInactive(active.id)).toBe(false);
    expect(navBucketChartInactive([active.id])).toBe(false);
  });
});
