import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { getAccountPositionMeta } from "./accountPosition.js";
import { upsertFundUnitSpotPreservingHistory } from "./fundUnitDaily.js";

describe("fintual cert v2 position", () => {
  it("values account as cuotas × fund_unit_daily", () => {
    const bucket = db
      .prepare(
        `SELECT id FROM asset_groups WHERE slug = 'fintual_risky_norris' OR slug LIKE '%__fintual_risky_norris' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    expect(bucket).toBeTruthy();
    const notes = "import:fintual|cert|key=risky_norris";
    const ins = db.prepare(
      `INSERT INTO accounts (asset_group_id, name, notes) VALUES (?, 'caca daca test', ?)`
    );
    const r = ins.run(bucket!.id, notes);
    const accountId = Number(r.lastInsertRowid);
    db.prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
       VALUES (?, 1000, '2025-01-10', 'vitest', 10)`
    ).run(accountId);
    upsertFundUnitSpotPreservingHistory({
      seriesKey: "fintual_cert_risky_norris",
      observationDay: "2025-01-10",
      unitValueClp: 100,
      note: "vitest",
      carryNote: "vitest-carry",
      dryRun: false,
    });
    const meta = getAccountPositionMeta(accountId, "fintual_risky_norris", {
      accountNotes: notes,
      accountName: "caca daca test",
      afpCuotasAsOfYmd: "2025-01-10",
    });
    expect(meta?.units).toBe(10);
    expect(meta?.afp_override_value_clp).toBe(1000);
    expect(meta?.afp_override_valor_cuota_clp).toBe(100);
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = 'fintual_cert_risky_norris' AND note = 'vitest'`).run();
  });
});
