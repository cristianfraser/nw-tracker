import { describe, expect, it } from "vitest";
import {
  applyFintualGoalsSnapshotToDb,
  collectFintualGoalValuationChanges,
  fintualMappedGoalsApiSignature,
  syncFintualFundUnitsFromResolutions,
} from "./fintualApplyShared.js";
import type { FintualGoalSnapshot } from "./fintualApiLib.js";
import type { FintualGoalNavResolution } from "./fintualRealAssetNav.js";
import { db } from "./db.js";

describe("fintualMappedGoalsApiSignature", () => {
  it("uses the goals API NAV, not the applied shares valuation", () => {
    const resolutions: FintualGoalNavResolution[] = [
      {
        row: {
          id: "2859",
          name: "caca daca",
          navClp: 10_400_000,
          matchedNotes: "import:fintual|cert|key=risky_norris",
        },
        goalsApiNavClp: 10_000_000,
        sharesValuationClp: 10_400_000,
        appliedNavClp: 10_400_000,
        units: 2696.9454,
        fintualShares: 2696.9454,
        fundPriceClp: 4136.9078,
        pending: null,
        mismatch: true,
        closureLagsPublish: false,
      },
    ];
    expect(fintualMappedGoalsApiSignature(resolutions)).toBe("2859:10000000");
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
      `INSERT INTO fund_unit_daily (series_key, day, unit_value, note)
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
          navClp: 10_400_000,
          matchedNotes: "import:fintual|cert|key=risky_norris",
        },
      ],
    };
    const resolutions: FintualGoalNavResolution[] = [
      {
        row: snap.goals[0]!,
        goalsApiNavClp: 10_000_000,
        sharesValuationClp: 10_400_000,
        appliedNavClp: 10_400_000,
        units: 2696.9454,
        fintualShares: 2696.9454,
        fundPriceClp: 4136.9078,
        pending: null,
        mismatch: true,
        closureLagsPublish: false,
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

describe("syncFintualFundUnitsFromResolutions", () => {
  it("writes nothing for a v2 account without a Fintual publish price (never NAV ÷ ledger cuotas)", () => {
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as { id: number };
    const notes = "import:fintual|cert|key=risky_norris";
    const accountId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'no-price vitest', ?, ?)`)
        .run(group.id, notes, notes).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
       VALUES (?, 1000, 'clp', '2099-03-01', 'vitest-no-price', 10)`
    ).run(accountId);
    db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = 'fintual_cert_risky_norris' AND day >= '2099-03-01'`).run();
    try {
      const resolutions: FintualGoalNavResolution[] = [
        {
          row: { id: "2859", name: "caca daca", navClp: 12_000, matchedNotes: notes },
          goalsApiNavClp: 12_000, // a retiro in transit: nav ≠ shares, no price for this poll
          sharesValuationClp: null,
          appliedNavClp: 12_000,
          units: 10,
          fintualShares: null,
          fundPriceClp: null,
          pending: { fulfillmentDepositsClp: 0, fulfillmentWithdrawalsClp: 0, paymentWithdrawalsClp: 2_000 },
          mismatch: false,
          closureLagsPublish: true,
        },
      ];
      expect(syncFintualFundUnitsFromResolutions(resolutions, "2099-03-02", false)).toBe(0);
      const bar = db
        .prepare(`SELECT 1 FROM fund_unit_daily WHERE series_key = 'fintual_cert_risky_norris' AND day = '2099-03-02'`)
        .get();
      expect(bar).toBeUndefined();
    } finally {
      db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
      db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = 'fintual_cert_risky_norris' AND day >= '2099-03-01'`).run();
    }
  });

  it("records the publish price of a goal's certificado account", () => {
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as { id: number };
    const notes = "import:fintual|cert|key=risky_norris";
    const existing = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(notes) as { id: number } | undefined;
    const accountId =
      existing?.id ??
      Number(
        db
          .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'publish vitest', ?, ?)`)
          .run(group.id, notes, notes).lastInsertRowid
      );
    db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = 'fintual_cert_risky_norris' AND day >= '2099-03-01'`).run();
    try {
      const resolutions: FintualGoalNavResolution[] = [
        {
          row: { id: "2859", name: "caca daca", navClp: 12_000, matchedNotes: notes },
          goalsApiNavClp: 12_000,
          sharesValuationClp: 12_000,
          appliedNavClp: 12_000,
          units: 10,
          fintualShares: 10,
          fundPriceClp: 1200,
          pending: null,
          mismatch: false,
          closureLagsPublish: false,
        },
      ];
      expect(syncFintualFundUnitsFromResolutions(resolutions, "2099-03-02", false)).toBe(1);
      const bar = db
        .prepare(`SELECT unit_value FROM fund_unit_daily WHERE series_key = 'fintual_cert_risky_norris' AND day = '2099-03-02'`)
        .get() as { unit_value: number } | undefined;
      expect(bar?.unit_value).toBe(1200);
    } finally {
      if (!existing) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
      db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = 'fintual_cert_risky_norris' AND day >= '2099-03-01'`).run();
    }
  });
});

describe("a live goal with no certificado account", () => {
  const snapOf = (id: string): FintualGoalSnapshot => ({
    fetchedAt: "2099-03-02T00:00:00.000Z",
    asOfDate: "2099-03-02",
    goals: [{ id, name: "vitest untracked goal", navClp: 1000, matchedNotes: null }],
  });

  it("throws for a goal the app does not track, instead of skipping it", () => {
    expect(() => collectFintualGoalValuationChanges(snapOf("999000111"))).toThrow(/not a tracked goal/);
    expect(() => applyFintualGoalsSnapshotToDb(snapOf("999000111"), true)).toThrow(/not a tracked goal/);
  });
});
