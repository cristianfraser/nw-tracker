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
  it("Reserva2 May 2026 attributes net withdrawals to aportes, not P/L", () => {
    const acc = db
      .prepare(`SELECT id FROM accounts WHERE notes LIKE '%reserva2%' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!acc) return;

    const perf = getAccountMonthlyPerformance(acc.id, "clp");
    const may = perf?.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === "2026-05");
    if (!may) return;

    expect(may.net_capital_flow).toBe(-5_700_000);
    expect(may.nominal_pl).not.toBeCloseTo(-5_620_042, 0);
    if (may.prior_closing != null && may.nominal_pl != null) {
      expect(may.nominal_pl).toBeCloseTo(
        may.closing_value - may.prior_closing - may.net_capital_flow,
        0
      );
    }
  });

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

  it("credit_card accounts report zero nominal_pl until installment-interest P/L", () => {
    const cc = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug = 'credit_card' OR g.slug LIKE '%credit_card%'
         LIMIT 5`
      )
      .all() as { id: number }[];
    const row = cc.find((r) => {
      const perf = getAccountMonthlyPerformance(r.id, "clp");
      return (perf?.monthly.length ?? 0) > 0;
    });
    if (!row) return;

    const perf = getAccountMonthlyPerformance(row.id, "clp");
    expect(perf?.monthly.length).toBeGreaterThan(0);
    for (const m of perf!.monthly) {
      expect(m.nominal_pl).toBe(0);
      expect(m.pct_month).toBeNull();
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

    const perf = getAccountMonthlyPerformance(row.id, "clp");
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

  it("Fintual cert v2 current month prior_closing matches prior month closing_value", () => {
    const acc = db
      .prepare(
        `SELECT a.id, a.notes, a.name, g.slug AS bucket_slug
         FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE a.notes LIKE '%import:fintual|cert|key=risky_norris%' LIMIT 1`
      )
      .get() as { id: number; notes: string | null; name: string; bucket_slug: string } | undefined;
    if (!acc) return;

    const perf = getAccountMonthlyPerformance(acc.id, "clp");
    if (!perf?.monthly.length) return;

    const curMk = monthKeyFromYmd(chileCalendarTodayYmd());
    const priorMk = priorCalendarMonthKey(curMk);
    const cur = perf.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === curMk);
    const prior = perf.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === priorMk);
    if (!cur || !prior || cur.prior_closing == null || cur.nominal_pl == null) return;

    expect(cur.prior_closing).toBeCloseTo(prior.closing_value, 0);
    expect(cur.nominal_pl).toBeCloseTo(
      cur.closing_value - prior.closing_value - cur.net_capital_flow,
      0
    );
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
      { import_key: acc.notes, name: acc.name }
    );
    expect(expectedPrior).not.toBeNull();
    expect(cur.prior_closing).toBe(expectedPrior);
    expect(cur.nominal_pl).toBeCloseTo(
      cur.closing_value - cur.prior_closing - cur.net_capital_flow,
      2
    );
    // Sanity bound, proportional: an absolute "near zero vs May cierre" bound rotted the
    // moment months rolled; a fund's current-month move beyond 20% of value means the
    // prior-month mark was wrong, which is what this test guards.
    expect(Math.abs(cur.nominal_pl)).toBeLessThan(0.2 * Math.abs(cur.closing_value));
  });

  it("suecia property P/L reconciles CLP net-equity marks minus CLP payments in month", () => {
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug LIKE '%__property' AND a.name LIKE '%suecia%' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;

    const perf = getAccountMonthlyPerformance(row.id, "clp");
    if (!perf?.monthly.length) return;

    const nov = perf.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === "2024-11");
    const dec = perf.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === "2024-12");
    const feb = perf.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === "2025-02");
    const mar = perf.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === "2025-03");
    if (!nov || !dec || !feb || !mar || nov.prior_closing == null || nov.nominal_pl == null) return;

    expect(nov.net_capital_flow).toBeGreaterThan(20_000_000);
    expect(nov.nominal_pl).toBeCloseTo(
      nov.closing_value - nov.prior_closing - nov.net_capital_flow,
      0
    );
    for (const r of [nov, dec, feb, mar]) {
      expect(Math.abs(r.nominal_pl ?? 0)).toBeLessThan(500_000);
    }
    expect(Math.abs((nov.nominal_pl ?? 0) + (dec.nominal_pl ?? 0))).toBeLessThan(400_000);
    expect(Math.abs((feb.nominal_pl ?? 0) + (mar.nominal_pl ?? 0))).toBeLessThan(600_000);
  });

  it("suecia property USD perf keeps sheet payments in USD (not CLP scale)", () => {
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug LIKE '%__property' AND a.name LIKE '%suecia%' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;

    // Latest month with an actual sheet payment: early in a new month both units are 0
    // flow (nothing posted yet) and the CLP-vs-USD scale check is vacuous.
    const clpMonthly = getAccountMonthlyPerformance(row.id, "clp")?.monthly ?? [];
    const clpWithFlow = clpMonthly.find((r) => Math.abs(r.net_capital_flow) > 1_000);
    if (!clpWithFlow) return;
    const mk = monthKeyFromYmd(clpWithFlow.as_of_date);
    const clp = clpWithFlow;
    const usd = getAccountMonthlyPerformance(row.id, "usd")?.monthly.find(
      (r) => monthKeyFromYmd(r.as_of_date) === mk
    );
    if (!clp || !usd || usd.prior_closing == null) return;

    expect(Math.abs(usd.net_capital_flow)).toBeLessThan(50_000);
    expect(usd.net_capital_flow).not.toBeCloseTo(clp.net_capital_flow, -3);
    expect(usd.nominal_pl).toBeCloseTo(
      usd.closing_value - usd.prior_closing - usd.net_capital_flow,
      0
    );
  });
});

describe("getGroupMonthlyPerformanceSeries", () => {
  it("delta_total equals sum of per-account nominal_pl for every month", () => {
    for (const groupSlug of ["brokerage", "retirement"] as const) {
      const series = getGroupMonthlyPerformanceSeries(groupSlug, "clp");
      if (!series.bar_accounts.length || !series.points.length) continue;

      for (const pt of series.points) {
        if (pt.delta_total == null) continue;
        const mk = monthKeyFromYmd(String(pt.as_of_date));
        let sum = 0;
        for (const ba of series.bar_accounts) {
          const perf = getAccountMonthlyPerformance(ba.account_id, "clp");
          const row = perf?.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === mk);
          if (row?.nominal_pl != null) sum += row.nominal_pl;
        }
        expect(pt.delta_total).toBeCloseTo(sum, 2);
      }
    }
  });

  it("brokerage current month delta_total matches full-bucket dashboard row MTD P/L", async () => {
    const curMk = monthKeyFromYmd(chileCalendarTodayYmd());
    const series = getGroupMonthlyPerformanceSeries("brokerage", "clp");
    if (!series.points.length) return;
    const last = series.points[series.points.length - 1]!;
    if (monthKeyFromYmd(String(last.as_of_date)) !== curMk) return;
    if (last.delta_total == null) return;

    const { buildDashboardAccountRows } = await import("./dashboardAccounts.js");
    const { withPortfolioGroupIndex } = await import("./portfolioGroupTree.js");
    const rows = await withPortfolioGroupIndex(async () => buildDashboardAccountRows(false));
    let cardSum = 0;
    let any = false;
    for (const r of rows) {
      if (r.dashboard_bucket_slug !== "brokerage" || r.exclude_from_group_totals === 1) continue;
      if (r.delta_month_clp != null && Number.isFinite(r.delta_month_clp)) {
        cardSum += r.delta_month_clp;
        any = true;
      }
    }
    if (!any) return;
    expect(last.delta_total).toBeCloseTo(cardSum, 0);
  });

  it("brokerage ytd_group matches consolidated ytd_nominal_pl for current month", async () => {
    const curMk = monthKeyFromYmd(chileCalendarTodayYmd());
    const series = getGroupMonthlyPerformanceSeries("brokerage", "clp");
    if (!series.points.length) return;
    const last = series.points[series.points.length - 1]!;
    if (monthKeyFromYmd(String(last.as_of_date)) !== curMk) return;
    if (last.ytd_group == null || !Number.isFinite(Number(last.ytd_group))) return;

    const { getGroupConsolidatedTables } = await import("./groupConsolidatedTables.js");
    const tables = getGroupConsolidatedTables("brokerage", "clp");
    const june = tables.consolidated_monthly.find((r) =>
      monthKeyFromYmd(String(r.as_of_date)) === curMk
    );
    if (june?.ytd_nominal_pl == null || !Number.isFinite(june.ytd_nominal_pl)) return;
    expect(Number(last.ytd_group)).toBeCloseTo(june.ytd_nominal_pl, 0);
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
