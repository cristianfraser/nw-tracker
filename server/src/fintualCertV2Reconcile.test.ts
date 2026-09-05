import { describe, expect, it } from "vitest";
import {
  cleanupUnreconciledFintualCertFundUnits,
  fintualCertV2AccountReconciledOnDay,
  fintualCertV2GoalsCuotaReconciled,
  fintualCertV2HeldFundMissingDayRow,
  fintualCertV2PreferGoalsNavDisplay,
  fintualGoalsApiPollYmdForState,
  fintualGoalsNavMatchesPriorPublishPosition,
  fintualMorningCarryPerFundUnresolved,
  parseFintualMappedNavSignature,
} from "./fintualCertV2Reconcile.js";
import { chileCalendarAddDays, type ChileWallClock } from "./chileDate.js";
import { db } from "./db.js";
import { fintualExpectsCuotaOnPollDay } from "./fintualPublishDate.js";
import { fintualGoalUnitsFromMovements } from "./fintualGoalUnits.js";
import { upsertFundUnitSpotPreservingHistory } from "./fundUnitDaily.js";

function chileClockAt(ymd: string, hour: number, minute = 0): ChileWallClock {
  return {
    ymd,
    year: Number(ymd.slice(0, 4)),
    month: Number(ymd.slice(5, 7)),
    day: Number(ymd.slice(8, 10)),
    hour,
    minute,
    monthKey: ymd.slice(0, 7),
  };
}

/** First Fintual publish day on/after `fromYmd` (test dates must not depend on hardcoded weekdays). */
function nextPublishDayOnOrAfter(fromYmd: string): string {
  let d = fromYmd;
  for (let i = 0; i < 14; i++) {
    if (fintualExpectsCuotaOnPollDay(d)) return d;
    d = chileCalendarAddDays(d, 1);
  }
  throw new Error(`no publish day within 14 days of ${fromYmd}`);
}

/** Find-or-create the account for a cert-v2 import key; returns cleanup for created rows only. */
function ensureCertV2Account(notes: string): { accountId: number; cleanup: () => void } {
  const existing = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(notes) as
    | { id: number }
    | undefined;
  if (existing) return { accountId: existing.id, cleanup: () => {} };
  const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as { id: number };
  const accountId = Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'vitest cert v2', ?, ?)`)
      .run(group.id, notes, notes).lastInsertRowid
  );
  return {
    accountId,
    cleanup: () => {
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    },
  };
}

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

  it("trusts local cuotas when a flow post-dates the last goals poll", () => {
    const diverged = {
      goalsNavClp: 18_476_613,
      cuotaPositionClp: 16_476_613,
      asOfYmd: "2026-07-08",
      todayYmd: "2026-07-08",
    } as const;
    // Manual flow dated after the last poll → NAV is stale → do not prefer it.
    expect(
      fintualCertV2PreferGoalsNavDisplay({
        ...diverged,
        lastGoalsPollYmd: "2026-07-07",
        newestLocalCuotaFlowYmd: "2026-07-08",
      })
    ).toBe(false);
    // Same-day flow (poll = flow day) → evening poll reflects real balance → still prefer NAV.
    expect(
      fintualCertV2PreferGoalsNavDisplay({
        ...diverged,
        lastGoalsPollYmd: "2026-07-08",
        newestLocalCuotaFlowYmd: "2026-07-08",
      })
    ).toBe(true);
    // Flow predates the poll → NAV already saw it → unchanged (prefer NAV on divergence).
    expect(
      fintualCertV2PreferGoalsNavDisplay({
        ...diverged,
        lastGoalsPollYmd: "2026-07-07",
        newestLocalCuotaFlowYmd: "2026-07-05",
      })
    ).toBe(true);
    // Missing either date → no gate → unchanged behavior.
    expect(
      fintualCertV2PreferGoalsNavDisplay({ ...diverged, newestLocalCuotaFlowYmd: "2026-07-08" })
    ).toBe(true);
    expect(
      fintualCertV2PreferGoalsNavDisplay({ ...diverged, lastGoalsPollYmd: "2026-07-07" })
    ).toBe(true);
  });

  it("resolves goals poll ymd from sync state (check sig wins over applied)", () => {
    expect(
      fintualGoalsApiPollYmdForState({
        fintualLastCheckSig: "2859:1",
        fintualLastCheckYmd: "2026-07-08",
        fintualLastAppliedSig: "2859:1",
        fintualLastAppliedYmd: "2026-07-07",
      })
    ).toBe("2026-07-08");
    expect(
      fintualGoalsApiPollYmdForState({
        fintualLastAppliedSig: "2859:1",
        fintualLastAppliedYmd: "2026-07-07",
      })
    ).toBe("2026-07-07");
    expect(fintualGoalsApiPollYmdForState({})).toBeNull();
  });

  it("treats a held fund's missing publish-day bar as unreconciled (late publisher)", () => {
    const notes = "import:fintual|cert|key=apv_b";
    const seriesKey = "fintual_cert_apv_b";
    const day = "2099-02-10";
    const { accountId, cleanup } = ensureCertV2Account(notes);
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
       VALUES (?, 1000, 'clp', ?, 'vitest-missing-row', 10)`
    ).run(accountId, day);
    db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ? AND day = ?`).run(seriesKey, day);
    try {
      const units = fintualGoalUnitsFromMovements(accountId)!;
      expect(units).toBeGreaterThan(0);

      // No bar on the publish day → missing-row is detected and the account is NOT reconciled.
      expect(fintualCertV2HeldFundMissingDayRow(accountId, notes, day)).toBe(true);
      expect(fintualCertV2AccountReconciledOnDay(accountId, notes, day, 1_000_000)).toBe(false);

      // Bar present → reconciled iff the goals NAV matches cuotas × px within tolerance.
      db.prepare(
        `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note)
         VALUES (?, ?, 100000, 'vitest-missing-row')
         ON CONFLICT(series_key, day) DO UPDATE SET unit_value_clp = excluded.unit_value_clp, note = excluded.note`
      ).run(seriesKey, day);
      expect(fintualCertV2HeldFundMissingDayRow(accountId, notes, day)).toBe(false);
      const pos = Math.round(units * 100000);
      expect(fintualCertV2AccountReconciledOnDay(accountId, notes, day, pos)).toBe(true);
      expect(fintualCertV2AccountReconciledOnDay(accountId, notes, day, pos + 50_000)).toBe(false);

      // An account with no cuotas stays vacuously reconciled even with the bar missing.
      expect(fintualCertV2HeldFundMissingDayRow(-1, notes, "2099-02-11")).toBe(false);
      expect(fintualCertV2AccountReconciledOnDay(-1, notes, "2099-02-11", 1_000_000)).toBe(true);
    } finally {
      db.prepare(`DELETE FROM movements WHERE account_id = ? AND note = 'vitest-missing-row'`).run(accountId);
      db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ? AND note = 'vitest-missing-row'`).run(seriesKey);
      cleanup();
    }
  });

  it("keeps the source stale before 18:00 while yesterday's publish-day bar is missing", () => {
    const notes = "import:fintual|cert|key=apv_b";
    const goalId = "78515";
    const seriesKey = "fintual_cert_apv_b";
    const pollYmd = nextPublishDayOnOrAfter("2099-03-01");
    const { accountId, cleanup } = ensureCertV2Account(notes);
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
       VALUES (?, 1000, 'clp', ?, 'vitest-morning-carry', 10)`
    ).run(accountId, pollYmd);
    db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ? AND day = ?`).run(seriesKey, pollYmd);
    try {
      const units = fintualGoalUnitsFromMovements(accountId)!;
      const nav = Math.round(units * 100000);
      const state = {
        fintualLastCheckYmd: pollYmd,
        fintualLastPublishYmd: pollYmd,
        fintualLastAppliedPublishYmd: pollYmd,
        fintualLastCheckSig: `${goalId}:${nav}`,
        fintualLastAppliedSig: `${goalId}:${nav}`,
      };
      const nextMorning = chileClockAt(chileCalendarAddDays(pollYmd, 1), 9);

      // Missing bar on yesterday's publish day → morning carry stays unresolved.
      expect(fintualMorningCarryPerFundUnresolved(nextMorning, state)).toBe(true);
      // Evening hours never use the morning carry.
      expect(
        fintualMorningCarryPerFundUnresolved(chileClockAt(chileCalendarAddDays(pollYmd, 1), 19), state)
      ).toBe(false);

      // Bar lands (fund published overnight) at a px matching the polled NAV → resolved.
      db.prepare(
        `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note)
         VALUES (?, ?, 100000, 'vitest-morning-carry')
         ON CONFLICT(series_key, day) DO UPDATE SET unit_value_clp = excluded.unit_value_clp, note = excluded.note`
      ).run(seriesKey, pollYmd);
      expect(fintualMorningCarryPerFundUnresolved(nextMorning, state)).toBe(false);
    } finally {
      db.prepare(`DELETE FROM movements WHERE account_id = ? AND note = 'vitest-morning-carry'`).run(accountId);
      db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ? AND note = 'vitest-morning-carry'`).run(seriesKey);
      cleanup();
    }
  });

  it("detects a goals NAV that lags the newest publish (matches a prior bar's position)", () => {
    const notes = "import:fintual|cert|key=reserva2";
    const seriesKey = "fintual_cert_reserva2";
    const d0 = "2099-04-01";
    const d1 = "2099-04-02";
    const { accountId, cleanup } = ensureCertV2Account(notes);
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
       VALUES (?, 1000, 'clp', ?, 'vitest-prior-pos', 10)`
    ).run(accountId, d0);
    const ins = db.prepare(
      `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note) VALUES (?, ?, ?, 'vitest-prior-pos')
       ON CONFLICT(series_key, day) DO UPDATE SET unit_value_clp = excluded.unit_value_clp, note = excluded.note`
    );
    ins.run(seriesKey, d0, 100000);
    ins.run(seriesKey, d1, 101000);
    try {
      const units = fintualGoalUnitsFromMovements(accountId)!;
      const posPrior = Math.round(units * 100000);
      const posLatest = Math.round(units * 101000);
      // NAV = position at the OLDER bar → lagging, not divergent.
      expect(fintualGoalsNavMatchesPriorPublishPosition(accountId, notes, posPrior)).toBe(true);
      // NAV at the newest bar (or anything else) → no prior-position match.
      expect(fintualGoalsNavMatchesPriorPublishPosition(accountId, notes, posLatest)).toBe(false);
      expect(fintualGoalsNavMatchesPriorPublishPosition(accountId, notes, null)).toBe(false);

      // The display gate then keeps the local cuota position instead of the stale NAV.
      expect(
        fintualCertV2PreferGoalsNavDisplay({
          goalsNavClp: posPrior,
          cuotaPositionClp: posLatest,
          asOfYmd: "2099-04-03",
          todayYmd: "2099-04-03",
          navMatchesPriorPublishPosition: true,
        })
      ).toBe(false);
      expect(
        fintualCertV2PreferGoalsNavDisplay({
          goalsNavClp: posPrior,
          cuotaPositionClp: posLatest,
          asOfYmd: "2099-04-03",
          todayYmd: "2099-04-03",
          navMatchesPriorPublishPosition: false,
        })
      ).toBe(true);
    } finally {
      db.prepare(`DELETE FROM movements WHERE account_id = ? AND note = 'vitest-prior-pos'`).run(accountId);
      db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ? AND note = 'vitest-prior-pos'`).run(seriesKey);
      cleanup();
    }
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
    const existing = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(notes) as
      | { id: number }
      | undefined;
    let accountId = existing?.id;
    if (accountId == null) {
      const ins = db.prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'cleanup vitest', ?, ?)`
      );
      const r = ins.run(bucket!.id, notes, notes);
      accountId = Number(r.lastInsertRowid);
    }
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
       VALUES (?, 1000, 'clp', ?, 'vitest', 10)`
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
