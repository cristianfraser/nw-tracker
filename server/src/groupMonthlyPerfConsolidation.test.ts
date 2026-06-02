import { describe, expect, it, vi } from "vitest";

const chileToday = vi.hoisted(() => ({ ymd: "2026-06-01" }));

vi.mock("./chileDate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chileDate.js")>();
  return {
    ...actual,
    chileCalendarTodayYmd: () => chileToday.ymd,
  };
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
    expect(Array.isArray(r.account_movements)).toBe(true);
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
