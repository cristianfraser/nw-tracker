import { describe, expect, it } from "vitest";
import {
  cleanupUnreconciledFintualCertFundUnits,
  fintualCertV2GoalsCuotaReconciled,
  fintualCertV2PreferGoalsNavDisplay,
  parseFintualMappedNavSignature,
} from "./fintualCertV2Reconcile.js";
import { db } from "./db.js";
import { upsertFundUnitSpotPreservingHistory } from "./fundUnitDaily.js";

describe("fintualCertV2Reconcile", () => {
  it("parses mapped nav signature", () => {
    const m = parseFintualMappedNavSignature("2859:10751884|16749:45743110");
    expect(m.get("2859")).toBe(10751884);
    expect(m.get("16749")).toBe(45743110);
  });

  it("detects goals vs cuota position mismatch", () => {
    expect(
      fintualCertV2GoalsCuotaReconciled({ goalsNavClp: 10_751_884, cuotaPositionClp: 11_157_014 })
    ).toBe(false);
    expect(
      fintualCertV2GoalsCuotaReconciled({ goalsNavClp: 10_751_884, cuotaPositionClp: 10_751_500 })
    ).toBe(true);
  });

  it("prefers goals API display when unreconciled", () => {
    expect(
      fintualCertV2PreferGoalsNavDisplay({
        goalsNavClp: 1005,
        cuotaPositionClp: 2500,
        asOfYmd: "2026-06-24",
        todayYmd: "2026-06-24",
      })
    ).toBe(true);
    expect(
      fintualCertV2PreferGoalsNavDisplay({
        goalsNavClp: 1000,
        cuotaPositionClp: 1000,
        asOfYmd: "2026-06-24",
        todayYmd: "2026-06-24",
      })
    ).toBe(false);
  });

  it("removes inferred fund_unit row when unreconciled", () => {
    const seriesKey = "fintual_cert_risky_norris";
    const day = "2099-01-15";
    const bucket = db
      .prepare(
        `SELECT id FROM asset_groups WHERE slug = 'fintual_risky_norris' OR slug LIKE '%__fintual_risky_norris' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    expect(bucket).toBeTruthy();
    const notes = "import:fintual|cert|key=risky_norris";
    const existing = db.prepare(`SELECT id FROM accounts WHERE notes = ?`).get(notes) as
      | { id: number }
      | undefined;
    let accountId = existing?.id;
    if (accountId == null) {
      const ins = db.prepare(
        `INSERT INTO accounts (asset_group_id, name, notes) VALUES (?, 'cleanup vitest', ?)`
      );
      const r = ins.run(bucket!.id, notes);
      accountId = Number(r.lastInsertRowid);
    }
    db.prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
       VALUES (?, 1000, ?, 'vitest', 10)`
    ).run(accountId, day);
    db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ? AND day = ?`).run(seriesKey, day);
    upsertFundUnitSpotPreservingHistory({
      seriesKey,
      observationDay: day,
      unitValueClp: 4136.9078,
      note: "fintual:api:goal-nav|vitest",
      carryNote: "vitest-carry",
      dryRun: false,
    });
    const removed = cleanupUnreconciledFintualCertFundUnits(
      day,
      new Map([["2859", 10_751_884]]),
      false
    );
    expect(removed).toBe(1);
    const row = db
      .prepare(`SELECT 1 FROM fund_unit_daily WHERE series_key = ? AND day = ?`)
      .get(seriesKey, day);
    expect(row).toBeUndefined();
    if (existing == null) {
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    }
    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note = 'vitest'`).run(accountId);
  });
});
