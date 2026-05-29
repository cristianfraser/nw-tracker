import { describe, expect, it } from "vitest";
import { accountBucketKindSlug } from "./accountBucket.js";
import { db } from "./db.js";
import { getAccountMonthlyPerformance, getGroupMonthlyPerformanceSeries } from "./accountPerformance.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";

describe("getAccountMonthlyPerformance", () => {
  it("returns empty monthly for movement-balance cash categories", () => {
    const rows = db
      .prepare(
        `SELECT a.id, g.slug AS bucket_slug
         FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         LIMIT 50`
      )
      .all() as { id: number; bucket_slug: string }[];
    const row = rows.find((r) =>
      isMovementBalanceCashCategory(accountBucketKindSlug(r.bucket_slug))
    );
    if (!row) return;

    expect(isMovementBalanceCashCategory(accountBucketKindSlug(row.bucket_slug))).toBe(true);
    const perf = getAccountMonthlyPerformance(row.id, "clp");
    expect(perf?.monthly).toEqual([]);
  });

  it("investment rows with prior_closing satisfy nominal_pl = closing − prior − net_flow", () => {
    const investRows = db
      .prepare(
        `SELECT a.id, g.slug AS bucket_slug FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE EXISTS (SELECT 1 FROM valuations v WHERE v.account_id = a.id)
         LIMIT 50`
      )
      .all() as { id: number; bucket_slug: string }[];
    const skip = new Set(["cuenta_corriente", "cuenta_ahorro_vivienda", "mortgage", "credit_card", "property"]);
    const row = investRows.find((r) => !skip.has(accountBucketKindSlug(r.bucket_slug)));
    if (!row) return;

    const perf = getAccountMonthlyPerformance(row.id, "clp");
    if (!perf?.monthly.length) return;

    for (const r of perf.monthly) {
      if (r.prior_closing == null || r.nominal_pl == null) continue;
      const expected = r.closing_value - r.prior_closing - r.net_capital_flow;
      expect(r.nominal_pl).toBeCloseTo(expected, 2);
    }
  });
});

describe("getGroupMonthlyPerformanceSeries", () => {
  it("returns bar_accounts and points for retirement when data exists", () => {
    const series = getGroupMonthlyPerformanceSeries("retirement", "clp");
    if (series.bar_accounts.length === 0) return;
    expect(series.group_slug).toBe("retirement");
    expect(series.unit).toBe("clp");
    expect(Array.isArray(series.points)).toBe(true);
    const first = series.points[0];
    if (first) {
      expect(typeof first.as_of_date).toBe("string");
    }
  });
});
