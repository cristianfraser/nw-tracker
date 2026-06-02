import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { checkingMovementBalanceClpAtCached } from "./checkingCartolaBalances.js";
import { getAccountValuationTimeseries, getGroupValuationTimeseries } from "./valuationTimeseries.js";

function cuentaCorrienteAccountId(): number | null {
  const row = db
    .prepare(
      `SELECT a.id FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE g.slug = 'cuenta_corriente' OR g.slug LIKE '%__cuenta_corriente'
       LIMIT 1`
    )
    .get() as { id: number } | undefined;
  return row?.id ?? null;
}

describe("getAccountValuationTimeseries (checking)", () => {
  it("returns month-end points from movement balances when valuations table is empty", () => {
    const accountId = cuentaCorrienteAccountId();
    if (accountId == null) return;

    const hasMovements = db
      .prepare(`SELECT 1 AS o FROM movements WHERE account_id = ? LIMIT 1`)
      .get(accountId) as { o: number } | undefined;
    if (!hasMovements) return;

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
    if (accountId == null) return;

    const hasMovements = db
      .prepare(`SELECT 1 AS o FROM movements WHERE account_id = ? LIMIT 1`)
      .get(accountId) as { o: number } | undefined;
    if (!hasMovements) return;

    const ts = getGroupValuationTimeseries("cash_eqs", "clp");
    expect(ts.accounts_in_group.points.length).toBeGreaterThan(0);

    const dk = String(accountId);
    const withValue = ts.accounts_in_group.points.filter(
      (p) => p[dk] != null && Number.isFinite(Number(p[dk]))
    );
    expect(withValue.length).toBeGreaterThan(0);
  });
});
