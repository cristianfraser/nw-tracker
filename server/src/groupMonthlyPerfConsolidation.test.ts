import { afterAll, describe, expect, it, vi } from "vitest";

import * as chileDate from "./chileDate.js";

const chileToday = vi.hoisted(() => ({ ymd: "2026-06-01" }));

const chileCalendarTodaySpy = vi
  .spyOn(chileDate, "chileCalendarTodayYmd")
  .mockImplementation(() => chileToday.ymd);

afterAll(() => {
  chileCalendarTodaySpy.mockRestore();
});

import { getGroupMonthlyPlSeries } from "./groupMonthlyPlSeries.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { db } from "./db.js";
import { getGroupConsolidatedTables } from "./groupConsolidatedTables.js";
import {
  consolidateGroupMonthlyPerf,
  monthlyPerfRowsForAccount,
} from "./groupMonthlyPerfConsolidation.js";
import { listAccountsForGroupTab } from "./valuationTimeseries.js";

/**
 * A mid-month "today" inside the Vitest person's history: seven months before its newest movement
 * (its broker holds SPY and the fund by then), so the current-month rows have real activity
 * whenever the test database was generated.
 */
function midHistoryTodayYmd(): string {
  const { last } = db.prepare(`SELECT MAX(occurred_on) AS last FROM movements`).get() as { last: string | null };
  if (!last) throw new Error("test database holds no movements");
  const d = new Date(`${last.slice(0, 7)}-15T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 7);
  return d.toISOString().slice(0, 10);
}

describe("groupMonthlyPerfConsolidation", () => {
  it("sums picked per-account nominal_pl for current month (not stale max-date row)", () => {
    chileToday.ymd = "2026-06-01";

    const rows = consolidateGroupMonthlyPerf([
      {
        account_id: 990_101,
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
        account_id: 990_102,
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
    chileToday.ymd = midHistoryTodayYmd();
    const curMk = monthKeyFromYmd(chileToday.ymd);
    const tables = getGroupConsolidatedTables("brokerage", "clp");
    const june = tables.consolidated_monthly.find((r) =>
      monthKeyFromYmd(String(r.as_of_date)) === curMk
    );
    expect(june).toBeDefined();
    expect(Number.isFinite(june!.ytd_nominal_pl)).toBe(true);

    const { buildDashboardAccountRows } = await import("./dashboardAccounts.js");
    const { withPortfolioGroupIndex } = await import("./portfolioGroupTree.js");
    const rows = await withPortfolioGroupIndex(async () => buildDashboardAccountRows("clp"));
    const ids = new Set(
      listAccountsForGroupTab("brokerage").map((a) => a.account_id)
    );
    let sumYear = 0;
    let counted = 0;
    for (const r of rows) {
      if (!ids.has(r.account_id) || r.exclude_from_group_totals === 1) continue;
      if (r.delta_year != null && Number.isFinite(r.delta_year)) {
        sumYear += r.delta_year;
        counted += 1;
      }
    }
    expect(counted).toBeGreaterThanOrEqual(2);
    expect(sumYear).toBeCloseTo(june!.ytd_nominal_pl!, 0);
  });

  it("brokerage consolidated current-month P/L matches performance-monthly delta_total", () => {
    chileToday.ymd = midHistoryTodayYmd();
    const curMk = monthKeyFromYmd(chileToday.ymd);
    const series = getGroupMonthlyPlSeries("brokerage", "clp");
    expect(series.bar_accounts.length).toBeGreaterThanOrEqual(2);

    const last = series.points[series.points.length - 1]!;
    expect(last).toBeDefined();
    expect(monthKeyFromYmd(String(last.as_of_date))).toBe(curMk);
    expect(Number.isFinite(Number(last.delta_total))).toBe(true);

    const tables = getGroupConsolidatedTables("brokerage", "clp");
    const june = tables.consolidated_monthly.find((r) =>
      String(r.as_of_date).startsWith(curMk)
    );
    expect(june).toBeDefined();
    expect(june!.nominal_pl).toBeCloseTo(Number(last.delta_total), 0);
  });

  it("cash_eqs includes movement-balance accounts when movements exist", () => {
    chileToday.ymd = midHistoryTodayYmd();
    const corriente = listAccountsForGroupTab("cash_eqs").find((a) =>
      a.bucket_slug.endsWith("cuenta_corriente")
    );
    expect(corriente).toBeDefined();

    const bounds = db
      .prepare(
        `SELECT MIN(occurred_on) AS first, MAX(occurred_on) AS last FROM movements
         WHERE account_id = @id OR from_account_id = @id OR to_account_id = @id`
      )
      .get({ id: corriente!.account_id }) as { first: string | null; last: string | null };
    expect(bounds.first).not.toBeNull();

    const monthly = monthlyPerfRowsForAccount(
      corriente!.account_id,
      corriente!.bucket_slug,
      "clp"
    );
    // One month-end row per month from the first movement through the last (later than "today"),
    // newest first, each month's prior close the previous month's close.
    const monthIndex = (ymd: string) => Number(ymd.slice(0, 4)) * 12 + Number(ymd.slice(5, 7));
    const months = monthIndex(bounds.last!) - monthIndex(bounds.first!) + 1;
    expect(monthly.map((r) => r.as_of_date.slice(0, 7))).toEqual(
      Array.from({ length: months }, (_, i) => {
        const m = monthIndex(bounds.last!) - i - 1;
        return `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}`;
      })
    );
    for (let i = 0; i + 1 < monthly.length; i++) {
      expect(monthly[i]!.prior_closing).toBeCloseTo(monthly[i + 1]!.closing_value, 0);
    }
  });
});
