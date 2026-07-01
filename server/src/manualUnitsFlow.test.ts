import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { accountRowForId } from "./accountRowForMovement.js";
import { movementCreateSchemaForAccount, validateMovementCreate } from "./movementUnitsPolicy.js";
import { fintualGoalUnitsFromMovementsThroughDate } from "./fintualGoalUnits.js";
import { fundSeriesKeyForAccount } from "./accountFundSeriesKey.js";
import { transferLegUnitsThroughDate } from "./movementTransfer.js";

/** A Fintual cuota account (units required, no brokerage flow kinds) with a fund series key. */
function findFintualAccountId(): number | null {
  const rows = db.prepare(`SELECT id FROM accounts`).all() as { id: number }[];
  for (const { id } of rows) {
    const account = accountRowForId(id);
    if (!account) continue;
    const schema = movementCreateSchemaForAccount(account);
    if (!schema || schema.units_delta !== "required" || schema.brokerage_flow_kinds) continue;
    if (fundSeriesKeyForAccount(id)) return id;
  }
  return null;
}

function findOtherAccountId(exclude: number): number | null {
  const row = db
    .prepare(`SELECT id FROM accounts WHERE id != ? LIMIT 1`)
    .get(exclude) as { id: number } | undefined;
  return row?.id ?? null;
}

describe("manual units flow (Fintual/crypto/AFP transfers)", () => {
  it("counts manual transfer legs toward Fintual cuotas (to = +, from = −)", () => {
    const fund = findFintualAccountId();
    if (fund == null) return;
    const other = findOtherAccountId(fund);
    if (other == null) return;

    const today = "2999-01-01"; // far future → include all rows
    const baseline = fintualGoalUnitsFromMovementsThroughDate(fund, today) ?? 0;

    const ins = db.prepare(
      `INSERT INTO movements (account_id, from_account_id, to_account_id, amount_clp, occurred_on, note, units_delta)
       VALUES (NULL, ?, ?, ?, ?, ?, ?)`
    );
    const aporteId = Number(ins.run(other, fund, 100000, "2020-01-01", "test:manual-units", 10).lastInsertRowid);
    const retiroId = Number(ins.run(fund, other, 40000, "2020-02-01", "test:manual-units", 4).lastInsertRowid);

    try {
      expect(transferLegUnitsThroughDate(fund, today)).toBeCloseTo(6, 4);
      const after = fintualGoalUnitsFromMovementsThroughDate(fund, today) ?? 0;
      expect(after - baseline).toBeCloseTo(6, 4);
    } finally {
      db.prepare(`DELETE FROM movements WHERE id IN (?, ?)`).run(aporteId, retiroId);
    }
  });

  it("requires units_delta and does not infer a stock flow_kind", () => {
    const fund = findFintualAccountId();
    if (fund == null) return;
    const other = findOtherAccountId(fund);
    if (other == null) return;
    const account = accountRowForId(fund)!;

    // Missing units → rejected.
    const missing = validateMovementCreate(
      account,
      { occurred_on: "1990-01-01", amount_clp: 100000, counterpart_account_id: other },
      fund
    );
    expect(missing.ok).toBe(false);

    // Valid aporte on a date with no valor cuota → reconcile is skipped; flow_kind stays null.
    const ok = validateMovementCreate(
      account,
      { occurred_on: "1990-01-01", amount_clp: 100000, units_delta: 10, counterpart_account_id: other },
      fund
    );
    expect(ok.ok).toBe(true);
    if (ok.ok && ok.mode === "transfer") {
      expect(ok.flow_kind).toBeNull();
      expect(ok.units_delta).toBe(10);
    } else {
      throw new Error("expected transfer mode");
    }
  });

  it("throws (fail fast) when CLP and cuotas disagree against valor cuota", () => {
    const fund = findFintualAccountId();
    if (fund == null) return;
    const other = findOtherAccountId(fund);
    if (other == null) return;
    const account = accountRowForId(fund)!;
    const seriesKey = fundSeriesKeyForAccount(fund)!;

    const testDay = "2099-06-15";
    db.prepare(
      `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note)
       VALUES (?, ?, ?, 'test:reconcile')
       ON CONFLICT(series_key, day) DO UPDATE SET unit_value_clp = excluded.unit_value_clp`
    ).run(seriesKey, testDay, 1000);

    try {
      // 10 cuotas × 1000 = 10 000 CLP; entering 500 000 is a mismatch → reject.
      const bad = validateMovementCreate(
        account,
        { occurred_on: testDay, amount_clp: 500000, units_delta: 10, counterpart_account_id: other },
        fund
      );
      expect(bad.ok).toBe(false);

      // Matching amount reconciles → accepted.
      const good = validateMovementCreate(
        account,
        { occurred_on: testDay, amount_clp: 10000, units_delta: 10, counterpart_account_id: other },
        fund
      );
      expect(good.ok).toBe(true);
    } finally {
      db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ? AND day = ?`).run(seriesKey, testDay);
    }
  });
});
