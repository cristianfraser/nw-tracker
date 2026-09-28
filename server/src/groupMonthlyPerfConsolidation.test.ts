import { afterAll, describe, expect, it, vi } from "vitest";

import * as chileDate from "./chileDate.js";

const chileToday = vi.hoisted(() => ({ ymd: "2026-06-01" }));

const chileCalendarTodaySpy = vi
  .spyOn(chileDate, "chileCalendarTodayYmd")
  .mockImplementation(() => chileToday.ymd);

afterAll(() => {
  chileCalendarTodaySpy.mockRestore();
});

import { getGroupMonthlyPerformanceSeries } from "./accountPerformance.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { db } from "./db.js";
import { getGroupConsolidatedTables } from "./groupConsolidatedTables.js";
import {
  consolidateGroupMonthlyPerf,
  loadAccountRowsForGroupConsolidation,
} from "./groupMonthlyPerfConsolidation.js";
import { listAccountsForGroupTab } from "./valuationTimeseries.js";

describe("groupMonthlyPerfConsolidation", () => {
  it("sums picked per-account nominal_pl for current month (not stale max-date row)", () => {
    chileToday.ymd = "2026-06-01";

    const rows = consolidateGroupMonthlyPerf([
      {
        account_id: 1,
        bucket_slug: "brokerage_mutual_funds",
        monthly: [
          {
            as_of_date: "2026-05-31",
            closing_value: 1_000_000,
            prior_closing: 900_000,
            net_capital_flow: 0,
            stock_units_inflow: 0,
            nominal_pl: 100_000,
            pct_month: null,
            ytd_nominal_pl: null,
            cumulative_nominal_pl: null,
            unit: "clp",
          },
          {
            as_of_date: "2026-06-01",
            closing_value: 1_000_500,
            prior_closing: 1_000_000,
            net_capital_flow: 0,
            stock_units_inflow: 0,
            nominal_pl: 500,
            pct_month: null,
            ytd_nominal_pl: null,
            cumulative_nominal_pl: null,
            unit: "clp",
          },
          {
            as_of_date: "2026-06-30",
            closing_value: 1_000_500,
            prior_closing: 1_000_000,
            net_capital_flow: 0,
            stock_units_inflow: 0,
            nominal_pl: 100_000,
            pct_month: null,
            ytd_nominal_pl: null,
            cumulative_nominal_pl: null,
            unit: "clp",
          },
        ],
      },
      {
        account_id: 2,
        bucket_slug: "brokerage_mutual_funds",
        monthly: [
          {
            as_of_date: "2026-05-31",
            closing_value: 500_000,
            prior_closing: 400_000,
            net_capital_flow: 0,
            stock_units_inflow: 0,
            nominal_pl: 50_000,
            pct_month: null,
            ytd_nominal_pl: null,
            cumulative_nominal_pl: null,
            unit: "clp",
          },
          {
            as_of_date: "2026-06-01",
            closing_value: 500_100,
            prior_closing: 500_000,
            net_capital_flow: 0,
            stock_units_inflow: 0,
            nominal_pl: 100,
            pct_month: null,
            ytd_nominal_pl: null,
            cumulative_nominal_pl: null,
            unit: "clp",
          },
          {
            as_of_date: "2026-06-30",
            closing_value: 500_100,
            prior_closing: 500_000,
            net_capital_flow: 0,
            stock_units_inflow: 0,
            nominal_pl: 50_000,
            pct_month: null,
            ytd_nominal_pl: null,
            cumulative_nominal_pl: null,
            unit: "clp",
          },
        ],
      },
    ]);

    const june = rows.find((r) => r.as_of_date.startsWith("2026-06"));
    expect(june).toBeDefined();
    expect(june!.as_of_date).toBe("2026-06-01");
    expect(june!.closing_value).toBe(1_000_500 + 500_100);
    expect(june!.prior_closing).toBe(1_000_000 + 500_000);
    expect(june!.net_capital_flow).toBe(0);
    expect(june!.nominal_pl).toBe(600);
  });

  it("a member that empties carries its zero close into the group month", () => {
    chileToday.ymd = "2026-05-15";
    // Synthetic ids with no ledger: prior closes come from the perf rows.
    const row = (
      as_of_date: string,
      prior_closing: number | null,
      net_capital_flow: number,
      closing_value: number
    ) => ({
      as_of_date,
      closing_value,
      prior_closing,
      net_capital_flow,
      stock_units_inflow: 0,
      nominal_pl: closing_value - (prior_closing ?? 0) - net_capital_flow,
      pct_month: null,
      ytd_nominal_pl: null,
      cumulative_nominal_pl: null,
      unit: "clp" as const,
    });
    const group = (bigApril: ReturnType<typeof row>, smallApril: ReturnType<typeof row>) =>
      consolidateGroupMonthlyPerf(
        [
          {
            account_id: 990_001,
            bucket_slug: "brokerage_mutual_funds",
            monthly: [bigApril, row("2026-03-31", null, 1_000_000, 1_000_000)],
          },
          {
            account_id: 990_002,
            bucket_slug: "brokerage_mutual_funds",
            monthly: [smallApril, row("2026-03-31", null, 10_000, 10_000)],
          },
        ],
        "clp"
      ).find((r) => r.as_of_date.startsWith("2026-04"))!;

    // The big member sold off for 994.000 (−6.000), the small one gained 100: −5.900 on the
    // 1.010.000 at work, not on the 16.000 the start frame leaves (−36,9%).
    const emptied = group(
      row("2026-04-30", 1_000_000, -994_000, 0),
      row("2026-04-30", 10_000, 0, 10_100)
    );
    expect(emptied.end_charged_flow).toBe(-994_000);
    expect(emptied.pct_month).toBeCloseTo(-5_900 / 1_010_000, 12);

    // Emptied INTO the other member: the group net cancels the transfer and the receiver
    // counts the money at the start, so nothing is charged at the end twice.
    const moved = group(
      row("2026-04-30", 1_000_000, -1_000_000, 0),
      row("2026-04-30", 10_000, 1_000_000, 1_010_100)
    );
    expect(moved.pct_month).toBeCloseTo(100 / 1_010_000, 12);

    // No member empties: the start frame, unchanged.
    const ordinary = group(
      row("2026-04-30", 1_000_000, -500_000, 499_000),
      row("2026-04-30", 10_000, 0, 10_100)
    );
    expect(ordinary.end_charged_flow).toBe(0);
    expect(ordinary.pct_month).toBeCloseTo(-900 / 510_000, 12);
  });

  it("consolidateGroupMonthlyPerf sums latest per-account month closes", () => {
    chileToday.ymd = "2026-04-15";

    const rows = consolidateGroupMonthlyPerf([
      {
        account_id: 1,
        bucket_slug: "brokerage_mutual_funds",
        monthly: [
          {
            as_of_date: "2026-03-31",
            closing_value: 100,
            prior_closing: 90,
            net_capital_flow: 0,
            stock_units_inflow: 0,
            nominal_pl: 10,
            pct_month: null,
            ytd_nominal_pl: null,
            cumulative_nominal_pl: null,
            unit: "clp",
          },
        ],
      },
      {
        account_id: 2,
        bucket_slug: "brokerage_mutual_funds",
        monthly: [
          {
            as_of_date: "2026-03-31",
            closing_value: 50,
            prior_closing: 40,
            net_capital_flow: 0,
            stock_units_inflow: 0,
            nominal_pl: 10,
            pct_month: null,
            ytd_nominal_pl: null,
            cumulative_nominal_pl: null,
            unit: "clp",
          },
        ],
      },
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0]!.closing_value).toBe(150);
    expect(rows[0]!.nominal_pl).toBe(20);
  });

  it("brokerage dashboard sum of delta_year_clp matches consolidated YTD nominal_pl", async () => {
    const curMk = monthKeyFromYmd(chileToday.ymd);
    const tables = getGroupConsolidatedTables("brokerage", "clp");
    const june = tables.consolidated_monthly.find((r) =>
      monthKeyFromYmd(String(r.as_of_date)) === curMk
    );
    if (june?.ytd_nominal_pl == null || !Number.isFinite(june.ytd_nominal_pl)) return;

    const { buildDashboardAccountRows } = await import("./dashboardAccounts.js");
    const { withPortfolioGroupIndex } = await import("./portfolioGroupTree.js");
    const rows = await withPortfolioGroupIndex(async () => buildDashboardAccountRows(false));
    const ids = new Set(
      listAccountsForGroupTab("brokerage").map((a) => a.account_id)
    );
    let sumYear = 0;
    for (const r of rows) {
      if (!ids.has(r.account_id) || r.exclude_from_group_totals === 1) continue;
      if (r.delta_year_clp != null && Number.isFinite(r.delta_year_clp)) {
        sumYear += r.delta_year_clp;
      }
    }
    expect(sumYear).toBeCloseTo(june.ytd_nominal_pl, 0);
  });

  it("brokerage consolidated current-month P/L matches performance-monthly delta_total", () => {
    const curMk = monthKeyFromYmd(chileToday.ymd);
    const series = getGroupMonthlyPerformanceSeries("brokerage", "clp");
    if (!series.bar_accounts.length || !series.points.length) return;

    const last = series.points[series.points.length - 1]!;
    if (monthKeyFromYmd(String(last.as_of_date)) !== curMk) return;
    if (last.delta_total == null || !Number.isFinite(Number(last.delta_total))) return;

    const tables = getGroupConsolidatedTables("brokerage", "clp");
    const june = tables.consolidated_monthly.find((r) =>
      String(r.as_of_date).startsWith(curMk)
    );
    expect(june).toBeDefined();
    expect(june!.nominal_pl).toBeCloseTo(Number(last.delta_total), 0);
  });

  it("net_worth consolidated tables build for dashboard home", () => {
    const r = getGroupConsolidatedTables("net_worth", "clp");
    expect(r.group_slug).toBe("net_worth");
    expect(Array.isArray(r.consolidated_monthly)).toBe(true);
    expect(Array.isArray(r.account_monthly)).toBe(true);
  });

  it("cash_eqs includes movement-balance accounts when movements exist", () => {
    const corriente = listAccountsForGroupTab("cash_eqs").find((a) =>
      a.bucket_slug.endsWith("cuenta_corriente")
    );
    if (!corriente) return;

    const hasMovements = db
      .prepare(`SELECT 1 AS o FROM movements WHERE account_id = ? LIMIT 1`)
      .get(corriente.account_id) as { o: number } | undefined;
    if (!hasMovements) return;

    const monthly = loadAccountRowsForGroupConsolidation(
      corriente.account_id,
      corriente.bucket_slug,
      "clp"
    );
    expect(monthly.length).toBeGreaterThan(0);
  });
});
