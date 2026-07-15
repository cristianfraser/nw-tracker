import { describe, expect, it } from "vitest";
import type { DashboardBundle, PortfolioGroupBundle } from "../queries/fetchers";
import type {
  AccountDetailBundleResponse,
  ConsolidatedMonthlyPerfRow,
  PeriodReturnsPayload,
} from "../types";
import {
  convertAccountDetailBundleUnit,
  convertConsolidatedMonthlyRowsUnit,
  convertDashboardBundleUnit,
  convertPeriodReturnsUnit,
  convertPortfolioGroupBundleUnit,
  resolveClpPerUsdForKeepPrev,
} from "./keepPrevBundleUnit";

const RATE = 950; // clp_per_usd

function clpDashboardBundle(): DashboardBundle {
  return {
    dash: {
      card_metrics_by_slug: {},
      totals: {
        net_worth_clp: 950_000,
        deposits_clp: 0,
        real_estate_clp: 0,
        retirement_clp: 0,
        brokerage_clp: 0,
        cash_eqs_clp: 0,
        liabilities_clp: 0,
        prior_closes: {
          month_end: "",
          year_end: "",
          month: {
            net_worth_clp: 0,
            real_estate_clp: 0,
            retirement_clp: 0,
            brokerage_clp: 0,
            cash_eqs_clp: 0,
          },
          year: {
            net_worth_clp: 0,
            real_estate_clp: 0,
            retirement_clp: 0,
            brokerage_clp: 0,
            cash_eqs_clp: 0,
          },
        },
      },
      allocation: [
        { group_slug: "brokerage", group_label: "Brokerage", value_clp: 950_000, color_rgb: "1,2,3" },
      ],
      accounts: [],
      inversiones_deposits_chart: {
        monthly_clp: [{ as_of_date: "2025-01-31", deposited: 190_000 }],
        yearly_clp: [{ as_of_date: "2025-12-31", deposited: 950_000 }],
      },
    },
    ts: {
      unit: "clp",
      overview: {
        lines: [{ dataKey: "total_nw", name: "Patrimonio neto", valueSeriesType: "data" }],
        points: [{ as_of_date: "2025-01-31", total_nw: 950_000 }],
      },
      accounts_ex_property: {
        accounts: [
          { account_id: 1, name: "A", dataKey: "1", valueSeriesType: "data" },
        ],
        points: [{ as_of_date: "2025-01-31", "1": 950_000 }],
      },
      patrimonio_usd_milestones_chart: {
        lines: [{ dataKey: "total_nw", name: "Patrimonio neto", valueSeriesType: "data" }],
        points: [{ as_of_date: "2025-01-31", total_nw: 1_000, "ref:250k": 250_000 }],
      },
    },
    fx: { date: "2025-01-31", clp_per_usd: RATE },
    retirementPerf: {
      unit: "clp",
      group_slug: "retirement",
      bar_accounts: [],
      points: [{ as_of_date: "2025-01-31", delta_total: 95_000 }],
    },
    brokeragePerf: null,
  };
}

describe("convertDashboardBundleUnit (CLP → USD)", () => {
  it("scales monetary point-series into USD and leaves the patrimonio chart untouched", () => {
    const usd = convertDashboardBundleUnit(clpDashboardBundle(), "usd", RATE);

    expect(usd.ts.unit).toBe("usd");
    expect(usd.ts.overview!.points[0]!.total_nw).toBeCloseTo(1_000, 6);
    expect(usd.ts.accounts_ex_property!.points[0]!["1"]).toBeCloseTo(1_000, 6);
    // patrimonio_usd_milestones_chart is always CLP — must NOT be scaled.
    expect(usd.ts.patrimonio_usd_milestones_chart!.points[0]!["ref:250k"]).toBe(250_000);
    expect(usd.ts.patrimonio_usd_milestones_chart!.points[0]!.total_nw).toBe(1_000);

    // perf deltas scale too.
    expect(usd.retirementPerf!.unit).toBe("usd");
    expect(usd.retirementPerf!.points[0]!.delta_total).toBeCloseTo(100, 6);
  });

  it("synthesizes the USD fields the dashboard charts read", () => {
    const usd = convertDashboardBundleUnit(clpDashboardBundle(), "usd", RATE);
    expect(usd.dash.allocation[0]!.value_usd).toBeCloseTo(1_000, 6);
    expect(usd.dash.inversiones_deposits_chart!.monthly_usd![0]!.deposited).toBeCloseTo(200, 6);
    expect(usd.dash.inversiones_deposits_chart!.yearly_usd![0]!.deposited).toBeCloseTo(1_000, 6);
    // dates are preserved, not scaled.
    expect(usd.ts.overview!.points[0]!.as_of_date).toBe("2025-01-31");
  });
});

describe("convertDashboardBundleUnit (USD → CLP)", () => {
  it("scales USD point-series up to CLP and leaves the dash unchanged", () => {
    const usdBundle = convertDashboardBundleUnit(clpDashboardBundle(), "usd", RATE);
    const backToClp = convertDashboardBundleUnit(usdBundle, "clp", RATE);
    expect(backToClp.ts.unit).toBe("clp");
    expect(backToClp.ts.overview!.points[0]!.total_nw).toBeCloseTo(950_000, 3);
  });
});

describe("convertPortfolioGroupBundleUnit", () => {
  it("scales the group valuation block and allocation pie", () => {
    const bundle: PortfolioGroupBundle = {
      accounts: [],
      ts: {
        unit: "clp",
        accounts_in_group: {
          accounts: [{ account_id: 7, name: "G", dataKey: "7", valueSeriesType: "data" }],
          points: [{ as_of_date: "2025-01-31", "7": 950_000 }],
        },
        group_allocation_pie: [{ name: "G", account_id: 7, value: 950_000 }],
      },
      groupPerf: {
        unit: "clp",
        group_slug: "brokerage",
        bar_accounts: [],
        points: [{ as_of_date: "2025-01-31", delta_total: 9_500 }],
      },
    };
    const usd = convertPortfolioGroupBundleUnit(bundle, "usd", RATE);
    expect(usd.ts.unit).toBe("usd");
    expect(usd.ts.accounts_in_group!.points[0]!["7"]).toBeCloseTo(1_000, 6);
    expect(usd.ts.group_allocation_pie![0]!.value).toBeCloseTo(1_000, 6);
    expect(usd.groupPerf!.points[0]!.delta_total).toBeCloseTo(10, 6);
  });
});

describe("convertAccountDetailBundleUnit (CLP → USD)", () => {
  const clpDetail = (): AccountDetailBundleResponse =>
    ({
      summary: { account_id: 5, deposits_clp: 950_000, latest_valuation_clp: 950_000 },
      ts: {
        unit: "clp",
        account_id: 5,
        name: "A",
        granularity: "monthly",
        accounts: {
          accounts: [{ account_id: 5, name: "A", dataKey: "5", valueSeriesType: "data" }],
          points: [{ as_of_date: "2025-01-31", "5": 950_000 }],
        },
        allocation_pie: [{ name: "A", account_id: 5, value: 950_000 }],
      },
      monthly_performance: {
        account_id: 5,
        category_slug: "brokerage",
        monthly: [
          {
            as_of_date: "2025-01-31",
            closing_value: 950_000,
            prior_closing: 855_000,
            net_capital_flow: 95_000,
            stock_units_inflow: 3, // units — must NOT scale
            nominal_pl: 9_500,
            pct_month: 0.01, // percent — must NOT scale
            ytd_nominal_pl: 9_500,
            cumulative_nominal_pl: 19_000,
            unit: "clp",
          },
        ],
      },
      dashboard_account_row: {
        account_id: 5,
        current_value_clp: 950_000,
        deposits_clp: 855_000,
      },
      // Unused-by-conversion fields kept minimal for the test.
      depositInflows: {},
      mortgageLedger: {},
      ccLedger: {},
      invNavAccounts: { accounts: [] },
      checkingCartolaMonths: null,
      period_returns: null,
    }) as unknown as AccountDetailBundleResponse;

  it("scales the chart, monthly perf money columns, and synthesizes the header USD value", () => {
    const usd = convertAccountDetailBundleUnit(clpDetail(), "usd", RATE);
    expect(usd.ts!.unit).toBe("usd");
    expect(usd.ts!.accounts.points[0]!["5"]).toBeCloseTo(1_000, 6);
    expect(usd.ts!.allocation_pie[0]!.value).toBeCloseTo(1_000, 6);

    const row = usd.monthly_performance!.monthly[0]!;
    expect(row.unit).toBe("usd");
    expect(row.closing_value).toBeCloseTo(1_000, 6);
    expect(row.nominal_pl).toBeCloseTo(10, 6);
    expect(row.cumulative_nominal_pl).toBeCloseTo(20, 6);
    // units / percent columns are untouched.
    expect(row.stock_units_inflow).toBe(3);
    expect(row.pct_month).toBe(0.01);

    expect(usd.dashboard_account_row!.current_value_usd).toBeCloseTo(1_000, 6);
  });

  it("leaves the header row untouched for a CLP target (CLP fields already present)", () => {
    const clp = convertAccountDetailBundleUnit(clpDetail(), "clp", RATE);
    expect(clp.dashboard_account_row!.current_value_clp).toBe(950_000);
  });
});

describe("convertConsolidatedMonthlyRowsUnit", () => {
  const clpRows = (): ConsolidatedMonthlyPerfRow[] => [
    {
      as_of_date: "2025-01-31",
      closing_value: 950_000,
      prior_closing: 855_000,
      net_capital_flow: 95_000,
      stock_units_inflow: 3, // units — must NOT scale
      nominal_pl: 9_500,
      pct_month: 0.01, // percent — must NOT scale
      ytd_nominal_pl: 9_500,
      cumulative_nominal_pl: -19_000,
    },
    {
      as_of_date: "2025-02-28",
      closing_value: 1_900_000,
      prior_closing: null,
      net_capital_flow: 0,
      stock_units_inflow: 0,
      nominal_pl: null,
      pct_month: null,
      ytd_nominal_pl: null,
      cumulative_nominal_pl: null,
    },
  ];

  it("CLP → USD divides money columns; percent/units/date untouched; nulls kept", () => {
    const usd = convertConsolidatedMonthlyRowsUnit(clpRows(), "clp", "usd", RATE);
    expect(usd[0]!.closing_value).toBeCloseTo(1_000, 6);
    expect(usd[0]!.prior_closing).toBeCloseTo(900, 6);
    expect(usd[0]!.net_capital_flow).toBeCloseTo(100, 6);
    expect(usd[0]!.nominal_pl).toBeCloseTo(10, 6);
    expect(usd[0]!.cumulative_nominal_pl).toBeCloseTo(-20, 6);
    expect(usd[0]!.stock_units_inflow).toBe(3);
    expect(usd[0]!.pct_month).toBe(0.01);
    expect(usd[0]!.as_of_date).toBe("2025-01-31");
    expect(usd[1]!.prior_closing).toBeNull();
    expect(usd[1]!.nominal_pl).toBeNull();
  });

  it("USD → CLP multiplies money columns", () => {
    const usd = convertConsolidatedMonthlyRowsUnit(clpRows(), "clp", "usd", RATE);
    const back = convertConsolidatedMonthlyRowsUnit(usd, "usd", "clp", RATE);
    expect(back[0]!.closing_value).toBeCloseTo(950_000, 3);
  });

  it("uf and same-unit payloads pass through by reference", () => {
    const rows = clpRows();
    expect(convertConsolidatedMonthlyRowsUnit(rows, "uf", "usd", RATE)).toBe(rows);
    expect(convertConsolidatedMonthlyRowsUnit(rows, "clp", "clp", RATE)).toBe(rows);
    expect(convertConsolidatedMonthlyRowsUnit(rows, "usd", "usd", RATE)).toBe(rows);
  });
});

describe("convertPeriodReturnsUnit", () => {
  const clpPayload = (): PeriodReturnsPayload => ({
    unit: "clp",
    as_of_date: "2025-01-31",
    mtd_is_live: false,
    d1_is_live: false,
    first_month: "2020-01",
    periods: [
      {
        period: "ytd",
        pct: 0.05,
        nominal_pl: 9_500,
        annualized_pct: null,
        months: 1,
        window_start_month: "2025-01",
      },
      {
        period: "y1",
        pct: null,
        nominal_pl: null,
        annualized_pct: null,
        months: 0,
        window_start_month: null,
      },
    ],
  });

  it("scales nominal_pl only and stamps the target unit", () => {
    const usd = convertPeriodReturnsUnit(clpPayload(), "usd", RATE);
    expect(usd.unit).toBe("usd");
    expect(usd.periods[0]!.nominal_pl).toBeCloseTo(10, 6);
    expect(usd.periods[0]!.pct).toBe(0.05);
    expect(usd.periods[1]!.nominal_pl).toBeNull();
  });

  it("uf and same-unit payloads pass through by reference", () => {
    const payload = clpPayload();
    expect(convertPeriodReturnsUnit(payload, "clp", RATE)).toBe(payload);
    const uf = { ...payload, unit: "uf" as const };
    expect(convertPeriodReturnsUnit(uf, "usd", RATE)).toBe(uf);
  });
});

describe("resolveClpPerUsdForKeepPrev", () => {
  it("prefers the bundle fx, falls back to the cached fx, else null", () => {
    expect(resolveClpPerUsdForKeepPrev({ date: "x", clp_per_usd: 900 }, undefined)).toBe(900);
    expect(
      resolveClpPerUsdForKeepPrev(null, { date: "x", clp_per_usd: 940 })
    ).toBe(940);
    expect(resolveClpPerUsdForKeepPrev(null, undefined)).toBeNull();
    expect(resolveClpPerUsdForKeepPrev({ date: "x", clp_per_usd: 0 }, undefined)).toBeNull();
  });
});
