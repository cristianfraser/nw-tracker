import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  checkingMovementBalanceAtMonthEnd,
  checkingMovementBalanceClpAt,
  checkingMovementBalanceClpAtCached,
  clearCheckingAccountValuations,
  clearCheckingBalanceCache,
  ensureCheckingOpeningBalance,
} from "./checkingCartolaBalances.js";
import { parseCheckingCartolaFile } from "./checkingCartolaParse.js";
import { resolveCfraserCheckingCartolasDir } from "./cfraserPaths.js";
import path from "node:path";

describe("checkingCartolaBalances", () => {
  it("computes balance as movement cumsum", () => {
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug = 'cuenta_corriente' OR g.slug LIKE '%__cuenta_corriente' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;

    const last = db
      .prepare(
        `SELECT occurred_on FROM movements WHERE account_id = ?
         ORDER BY occurred_on DESC, id DESC LIMIT 1`
      )
      .get(row.id) as { occurred_on: string } | undefined;
    if (!last) return;

    const sqlSum = db
      .prepare(
        `SELECT COALESCE(SUM(amount_clp), 0) AS t FROM movements
         WHERE account_id = ? AND occurred_on <= ?`
      )
      .get(row.id, last.occurred_on) as { t: number };
    expect(checkingMovementBalanceClpAt(row.id, last.occurred_on)).toBe(Math.round(Number(sqlSum.t)));
  });

  it("cache returns same value until cleared", () => {
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug = 'cuenta_corriente' OR g.slug LIKE '%__cuenta_corriente' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;
    const last = db
      .prepare(`SELECT occurred_on FROM movements WHERE account_id = ? ORDER BY occurred_on DESC LIMIT 1`)
      .get(row.id) as { occurred_on: string } | undefined;
    if (!last) return;

    clearCheckingBalanceCache(row.id);
    const a = checkingMovementBalanceClpAtCached(row.id, last.occurred_on);
    const b = checkingMovementBalanceClpAtCached(row.id, last.occurred_on);
    expect(a).toBe(b);
  });

  it("Jan 2020 month-end matches cartola saldo final (opening only when bridge needed)", () => {
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug = 'cuenta_corriente' OR g.slug LIKE '%__cuenta_corriente' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;

    const jan = path.join(
      resolveCfraserCheckingCartolasDir(),
      "2020-01-31 Cartola de cuenta Corriente - Enero 2020.xlsx"
    );
    const cartola = parseCheckingCartolaFile(jan);
    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE 'import:cartola|opening|%'`).run(
      row.id
    );
    clearCheckingBalanceCache(row.id);
    const opening = ensureCheckingOpeningBalance(row.id);
    expect(opening.inserted).toBe(false);
    expect(checkingMovementBalanceAtMonthEnd(row.id, "2020-01")).toBe(cartola.saldo_final_clp);
  });

  it("clearCheckingAccountValuations removes persisted rows", () => {
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug = 'cuenta_corriente' OR g.slug LIKE '%__cuenta_corriente' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;
    const cleared = clearCheckingAccountValuations(row.id);
    expect(cleared).toBeGreaterThanOrEqual(0);
    const left = db
      .prepare(`SELECT COUNT(*) AS c FROM valuations WHERE account_id = ?`)
      .get(row.id) as { c: number };
    expect(left.c).toBe(0);
  });
});
