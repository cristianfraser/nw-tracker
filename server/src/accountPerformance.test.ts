import { describe, expect, it } from "vitest";
import { accountBucketKindSlug } from "./accountBucket.js";
import { db } from "./db.js";
import {
  valuationSeriesMonthlyPerformance,
  reanchorMonthlyPerfToCalendarMonthEnds,
  type AccountMonthlyPerformanceRow,
} from "./accountPerformance.js";
import { priorCalendarMonthKey } from "./accountPeriodMarks.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
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

  it("a first month (no prior close) divides by its net inflow; net withdrawals read null", () => {
    const first = (netFlow: number): AccountMonthlyPerformanceRow => ({
      as_of_date: "2026-05-31",
      closing_value: 300_000,
      prior_closing: null,
      net_capital_flow: netFlow,
      stock_units_inflow: 0,
      nominal_pl: null,
      pct_month: null,
      ytd_nominal_pl: null,
      cumulative_nominal_pl: null,
      unit: "clp",
    });
    const opts = { accountId: 999_999, bucketSlug: "brokerage_mutual_funds", unit: "clp" as const };
    // Deposited 2xx.xxx, closed at 3xx.xxx: +20%.
    expect(reanchorMonthlyPerfToCalendarMonthEnds([first(250_000)], opts)[0]!.pct_month).toBeCloseTo(
      0.2,
      12
    );
    // Withdrew 5x.xxx from a balance the ledger never saw arrive: the old inline ratio read
    // 3xx.xxx / −5x.xxx = −700%, a gain as a loss.
    const out = reanchorMonthlyPerfToCalendarMonthEnds([first(-50_000)], opts)[0]!;
    expect(out.nominal_pl).toBe(350_000);
    expect(out.pct_month).toBeNull();
  });
});

describe("valuationSeriesMonthlyPerformance", () => {
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
    const perf = valuationSeriesMonthlyPerformance(row.id, "clp");
    expect(perf?.monthly).toEqual([]);
  });

  it("credit_card rows are loss-negative cost (charges + fx): nominal_pl = prior − closing − net_flow", () => {
    const cc = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug = 'credit_card' OR g.slug LIKE '%credit_card%'
         LIMIT 5`
      )
      .all() as { id: number }[];
    const row = cc.find((r) => {
      const perf = valuationSeriesMonthlyPerformance(r.id, "clp");
      return (perf?.monthly.length ?? 0) > 0;
    });
    if (!row) return;

    const perf = valuationSeriesMonthlyPerformance(row.id, "clp");
    expect(perf?.monthly.length).toBeGreaterThan(0);
    for (const m of perf!.monthly) {
      // A card's P/L is what the bank charged plus the fx revaluation of the dollars it owed (a
      // gain when the peso rose), and the rest of the balance move is capital flow — the
      // liability identity the daily series shares.
      const prior = m.prior_closing ?? 0;
      expect(m.nominal_pl).not.toBeNull();
      expect(m.nominal_pl!).toBeCloseTo(prior - m.closing_value - m.net_capital_flow, 6);
    }
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

    const perf = valuationSeriesMonthlyPerformance(row.id, "clp");
    if (!perf?.monthly.length) return;

    for (const r of perf.monthly) {
      if (r.prior_closing == null || r.nominal_pl == null) continue;
      const expected = r.closing_value - r.prior_closing - r.net_capital_flow;
      expect(r.nominal_pl).toBeCloseTo(expected, 2);
    }

    const asc = [...perf.monthly].reverse();
    for (let i = 1; i < asc.length; i++) {
      const cur = asc[i]!;
      const prev = asc[i - 1]!;
      const curMk = monthKeyFromYmd(cur.as_of_date);
      if (priorCalendarMonthKey(curMk) !== monthKeyFromYmd(prev.as_of_date)) continue;
      if (cur.prior_closing == null || cur.nominal_pl == null) continue;
      expect(cur.prior_closing).toBeCloseTo(prev.closing_value, 2);
      expect(cur.nominal_pl).toBeCloseTo(
        cur.closing_value - prev.closing_value - cur.net_capital_flow,
        2
      );
    }
  });
});

