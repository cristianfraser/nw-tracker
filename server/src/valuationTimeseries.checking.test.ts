import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { checkingMovementBalanceClpAtCached } from "./checkingCartolaBalances.js";
import { getAccountValuationTimeseries, getGroupValuationTimeseries } from "./valuationTimeseries.js";

/** The Vitest person's checking account: movements only, no stored valuations. */
function cuentaCorrienteAccountId(): number {
  const row = db
    .prepare(
      `SELECT a.id FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE g.slug = 'cuenta_corriente' OR g.slug LIKE '%__cuenta_corriente'
       LIMIT 1`
    )
    .get() as { id: number } | undefined;
  if (!row) throw new Error("test person has no cuenta corriente account");
  const movements = db
    .prepare(`SELECT COUNT(*) AS n FROM movements WHERE account_id = ?`)
    .get(row.id) as { n: number };
  if (movements.n === 0) throw new Error(`cuenta corriente ${row.id} has no movements`);
  const valuations = db
    .prepare(`SELECT COUNT(*) AS n FROM valuations WHERE account_id = ?`)
    .get(row.id) as { n: number };
  if (valuations.n !== 0) throw new Error(`cuenta corriente ${row.id} has stored valuations`);
  return row.id;
}

describe("getAccountValuationTimeseries (checking)", () => {
  it("returns month-end points from movement balances when valuations table is empty", () => {
    const accountId = cuentaCorrienteAccountId();

    const ts = getAccountValuationTimeseries(accountId, "clp");
    expect(ts).not.toBeNull();
    expect(ts!.accounts.points.length).toBeGreaterThan(0);

    const dk = String(accountId);
    const lastPt = ts!.accounts.points[ts!.accounts.points.length - 1]!;
    const asOf = String(lastPt.as_of_date);
    const chartVal = lastPt[dk];
    expect(chartVal).not.toBeNull();
    expect(Number(chartVal)).toBe(checkingMovementBalanceClpAtCached(accountId, asOf));
  });
});

describe("getGroupValuationTimeseries (cash_eqs checking)", () => {
  it("includes non-null checking series when movements exist", () => {
    const accountId = cuentaCorrienteAccountId();

    const ts = getGroupValuationTimeseries("cash_eqs", "clp");
    expect(ts.accounts_in_group.points.length).toBeGreaterThan(0);

    const dk = String(accountId);
    const withValue = ts.accounts_in_group.points.filter(
      (p) => p[dk] != null && Number.isFinite(Number(p[dk]))
    );
    expect(withValue.length).toBeGreaterThan(0);
    // Every checking point is the movement balance at its date (the ledger the account chart reads).
    for (const p of withValue) {
      expect(Number(p[dk])).toBe(checkingMovementBalanceClpAtCached(accountId, String(p.as_of_date)));
    }
  });
});
