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

  it("resolves liability_view CC rows to operational master for inactivity", () => {
    const row = db
      .prepare(
        `SELECT v.id AS view_id, v.source_account_id AS master_id
         FROM accounts v
         WHERE v.account_kind = 'liability_view'
           AND v.notes = 'liability_view|credit_card'
         LIMIT 1`
      )
      .get() as { view_id: number; master_id: number } | undefined;
    if (!row) return;
    expect(accountIdForInactiveCheck(row.view_id)).toBe(row.master_id);
    expect(accountChartInactive(row.view_id)).toBe(accountChartInactive(row.master_id));
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
    expect(navBucketChartInactive([active.id])).toBe(accountChartInactive(active.id));
  });
});
