import { describe, expect, it } from "vitest";
import {
  collectFintualGoalValuationChanges,
  fintualMappedGoalsApiSignature,
  shouldRecordFintualCertFundUnit,
} from "../scripts/fintualApplyShared.js";
import type { FintualGoalSnapshot } from "../scripts/fintualApiLib.js";
import type { FintualGoalNavResolution } from "../scripts/fintualRealAssetNav.js";
import { db } from "./db.js";
import { upsertFundUnitSpotPreservingHistory } from "./fundUnitDaily.js";

describe("shouldRecordFintualCertFundUnit", () => {
  it("allows real_assets publish price", () => {
    expect(
      shouldRecordFintualCertFundUnit({
        accountId: 1,
        importNotes: "import:fintual|cert|key=risky_norris",
        asOfYmd: "2026-06-24",
        goalsNavClp: 10_751_884,
        fundPriceClp: 4136.9,
      })
    ).toBe(true);
  });

  it("skips inferred write when goals API NAV unchanged", () => {
    const bucket = db
      .prepare(
        `SELECT id FROM asset_groups WHERE slug = 'fintual_risky_norris' OR slug LIKE '%__fintual_risky_norris' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    expect(bucket).toBeTruthy();
    const notes = "import:fintual|cert|key=risky_norris";
    const ins = db.prepare(
      `INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'reconcile test', ?, ?)`
    );
    const r = ins.run(bucket!.id, notes, notes);
    const accountId = Number(r.lastInsertRowid);
    db.prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
       VALUES (?, 1000, '2025-01-10', 'vitest', 10)`
    ).run(accountId);
    upsertFundUnitSpotPreservingHistory({
      seriesKey: "fintual_cert_risky_norris",
      observationDay: "2025-01-09",
      unitValueClp: 100,
      note: "vitest",
      carryNote: "vitest-carry",
      dryRun: false,
    });
    expect(
      shouldRecordFintualCertFundUnit({
        accountId,
        importNotes: notes,
        asOfYmd: "2025-01-10",
        goalsNavClp: 1000,
        fundPriceClp: null,
      })
    ).toBe(false);
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    db.prepare(
      `DELETE FROM fund_unit_daily WHERE series_key = 'fintual_cert_risky_norris' AND note = 'vitest'`
    ).run();
  });
});

describe("fintualMappedGoalsApiSignature", () => {
  it("uses goals API NAV not applied real_assets NAV", () => {
    const resolutions: FintualGoalNavResolution[] = [
      {
        row: {
          id: "2859",
          name: "caca daca",
          navClp: 11_157_014,
          matchedNotes: "import:fintual|cert|key=risky_norris",
        },
        goalsApiNavClp: 10_751_884,
        realAssetsNavClp: 11_157_014,
        appliedNavClp: 11_157_014,
        units: 2696.9454,
        fundPriceClp: 4136.9078,
        mismatch: true,
      },
    ];
    expect(fintualMappedGoalsApiSignature(resolutions)).toBe("2859:10751884");
  });
});

describe("collectFintualGoalValuationChanges v2", () => {
  it("logs valor cuota and goals API separately", () => {
    // Own v2 fixture: goal 2859 resolves to the risky_norris cert-v2 account; a prior
    // fund_unit_daily bar (4100 ≠ resolution 4136.9078) forces the "valor cuota" change.
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as {
      id: number;
    };
    const accountId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'caca daca', ?, ?)`)
        .run(group.id, "import:fintual|cert|key=risky_norris", "import:fintual|cert|key=risky_norris").lastInsertRowid
    );
    db.prepare(
      `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note)
       VALUES ('fintual_cert_risky_norris', '2026-06-23', 4100, 'test:fixture')
       ON CONFLICT(series_key, day) DO NOTHING`
    ).run();
    const snap: FintualGoalSnapshot = {
      fetchedAt: "2026-06-24T00:00:00.000Z",
      asOfDate: "2026-06-24",
      goals: [
        {
          id: "2859",
          name: "caca daca",
          navClp: 11_157_014,
          matchedNotes: "import:fintual|cert|key=risky_norris",
        },
      ],
    };
    const resolutions: FintualGoalNavResolution[] = [
      {
        row: snap.goals[0]!,
        goalsApiNavClp: 10_751_884,
        realAssetsNavClp: 11_157_014,
        appliedNavClp: 11_157_014,
        units: 2696.9454,
        fundPriceClp: 4136.9078,
        mismatch: true,
      },
    ];
    try {
      const changes = collectFintualGoalValuationChanges(snap, resolutions);
      const labels = changes.map((c) => c.label);
      expect(labels.some((l) => l.includes("valor cuota"))).toBe(true);
      expect(labels.some((l) => l.includes("goals API"))).toBe(true);
    } finally {
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
      db.prepare(
        `DELETE FROM fund_unit_daily
         WHERE series_key = 'fintual_cert_risky_norris' AND day = '2026-06-23' AND note = 'test:fixture'`
      ).run();
    }
  });
});
