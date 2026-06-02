import { describe, expect, it } from "vitest";
import { accountBucketKindSlug } from "./accountBucket.js";
import { db } from "./db.js";
import {
  getAccountMonthlyPerformance,
  getGroupMonthlyPerformanceSeries,
  reanchorMonthlyPerfToCalendarMonthEnds,
  type AccountMonthlyPerformanceRow,
} from "./accountPerformance.js";
import {
  monthEndCloseClpForAccount,
  priorCalendarMonthKey,
} from "./accountPeriodMarks.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";

describe("reanchorMonthlyPerfToCalendarMonthEnds", () => {
  it("recomputes June nominal from prior calendar month-end close", () => {
    const picked: AccountMonthlyPerformanceRow[] = [
      {
        as_of_date: "2026-05-31",
        closing_value: 53_000_000,
        prior_closing: 50_000_000,
        net_capital_flow: 0,
        stock_units_inflow: 0,
        nominal_pl: 3_000_000,
        pct_month: 0.06,
        ytd_nominal_pl: 3_000_000,
        cumulative_nominal_pl: 3_000_000,
        unit: "clp",
      },
      {
        as_of_date: "2026-06-01",
        closing_value: 53_100_000,
        prior_closing: 53_000_000,
        net_capital_flow: 0,
        stock_units_inflow: 0,
        nominal_pl: 3_000_000,
        pct_month: null,
        ytd_nominal_pl: null,
        cumulative_nominal_pl: null,
        unit: "clp",
      },
    ];
    const out = reanchorMonthlyPerfToCalendarMonthEnds(picked, {
      accountId: 999_999,
      bucketSlug: "brokerage_mutual_funds",
      unit: "clp",
    });
    expect(out[1]!.prior_closing).toBe(53_000_000);
    expect(out[1]!.nominal_pl).toBeCloseTo(100_000, 0);
  });
});

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

  it("mega caca current-month P/L uses account mark at prior month-end (near 0 when live ≈ May cierre)", () => {
    const acc = db
      .prepare(
        `SELECT a.id, a.notes, a.name, g.slug AS bucket_slug
         FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE a.name = 'mega caca' LIMIT 1`
      )
      .get() as { id: number; notes: string | null; name: string; bucket_slug: string } | undefined;
    if (!acc) return;

    const perf = getAccountMonthlyPerformance(acc.id, "clp");
    if (!perf?.monthly.length) return;

    const asc = [...perf.monthly].reverse();
    const curMk = monthKeyFromYmd(chileCalendarTodayYmd());
    const priorMk = priorCalendarMonthKey(curMk);
    const cur = asc.find((r) => monthKeyFromYmd(r.as_of_date) === curMk);
    if (!cur || cur.prior_closing == null || cur.nominal_pl == null) return;

    const expectedPrior = monthEndCloseClpForAccount(
      acc.id,
      acc.bucket_slug,
      asc,
      priorMk,
      { notes: acc.notes, name: acc.name }
    );
    expect(expectedPrior).not.toBeNull();
    expect(cur.prior_closing).toBe(expectedPrior);
    expect(cur.nominal_pl).toBeCloseTo(
      cur.closing_value - cur.prior_closing - cur.net_capital_flow,
      2
    );
    expect(Math.abs(cur.nominal_pl)).toBeLessThan(50_000);
  });
});

describe("getGroupMonthlyPerformanceSeries", () => {
  it("current month delta_total equals sum of per-account nominal_pl", () => {
    const curMk = monthKeyFromYmd(chileCalendarTodayYmd());
    for (const groupSlug of ["brokerage", "retirement"] as const) {
      const series = getGroupMonthlyPerformanceSeries(groupSlug, "clp");
      if (!series.bar_accounts.length || !series.points.length) continue;

      const last = series.points[series.points.length - 1]!;
      if (monthKeyFromYmd(last.as_of_date) !== curMk) continue;
      if (last.delta_total == null) continue;

      let sum = 0;
      for (const ba of series.bar_accounts) {
        const perf = getAccountMonthlyPerformance(ba.account_id, "clp");
        const row = perf?.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === curMk);
        if (row?.nominal_pl != null) sum += row.nominal_pl;
      }
      expect(last.delta_total).toBeCloseTo(sum, 2);
    }
  });

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
