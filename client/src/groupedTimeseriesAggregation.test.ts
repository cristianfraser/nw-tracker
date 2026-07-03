import { describe, expect, it } from "vitest";
import {
  aggregatePerformanceByBucket,
  aggregatePieByBucket,
  aggregateValuationByBucket,
} from "./groupedTimeseriesAggregation";
import type { AccountListRow, GroupMonthlyPerformanceResponse, TimeseriesBlock } from "./types";

function listRow(
  partial: Pick<AccountListRow, "id" | "name" | "category_slug"> & Partial<AccountListRow>
): AccountListRow {
  return {
    notes: null,
    created_at: "",
    category_label: partial.category_slug,
    group_slug: "brokerage",
    group_label: "Brokerage",
    ...partial,
  };
}

describe("aggregatePieByBucket", () => {
  it("sums slice values that map to the same bucket", () => {
    const meta = {
      a: { key: "a", accountId: -1, dataKey: "d_a", depKey: "dep_a", barDataKey: "pl_a", name: "A" },
      b: { key: "b", accountId: -2, dataKey: "d_b", depKey: "dep_b", barDataKey: "pl_b", name: "B" },
    };
    const out = aggregatePieByBucket(
      [
        { name: "x", account_id: 10, value: 100 },
        { name: "y", account_id: 11, value: 50 },
        { name: "z", account_id: 20, value: 200 },
      ],
      ["a", "b"],
      meta,
      (id) => (id === 10 || id === 11 ? "a" : id === 20 ? "b" : null)
    );
    expect(out).toEqual([
      { name: "A", account_id: -1, value: 150 },
      { name: "B", account_id: -2, value: 200 },
    ]);
  });
});

describe("aggregateValuationByBucket", () => {
  it("prefers nav bucket color_rgb over server synthetic map and member averaging", () => {
    const block: TimeseriesBlock = {
      accounts: [
        {
          account_id: 10,
          name: "Fund A",
          dataKey: "acc_10",
          valueSeriesType: "data",
        },
        {
          account_id: 20,
          name: "Fund B",
          dataKey: "acc_20",
          valueSeriesType: "data",
        },
      ],
      points: [
        { date: "2024-01-31", acc_10: 100, acc_20: 200 },
        { date: "2024-02-29", acc_10: 110, acc_20: 210 },
      ],
      synthetic_group_color_rgb: {
        "-720": "255,0,0",
      },
    };
    const meta = {
      funds: {
        key: "brokerage_mutual_funds",
        accountId: -720,
        dataKey: "nav_brokerage_mutual_funds",
        depKey: "nav_brokerage_mutual_funds_dep",
        barDataKey: "pl_nav_brokerage_mutual_funds",
        name: "Mutual funds",
        color_rgb: "120,80,200",
      },
      stocks: {
        key: "brokerage_acciones",
        accountId: -721,
        dataKey: "nav_brokerage_acciones",
        depKey: "nav_brokerage_acciones_dep",
        barDataKey: "pl_nav_brokerage_acciones",
        name: "Acciones",
        color_rgb: "40,120,60",
      },
    };

    const out = aggregateValuationByBucket(
      block,
      [],
      ["funds", "stocks"],
      meta,
      (id) => (id === 10 ? "funds" : id === 20 ? "stocks" : null)
    );

    const funds = out.accounts?.find((a) => a.account_id === -720);
    const stocks = out.accounts?.find((a) => a.account_id === -721);
    expect(funds?.color_rgb).toBe("120,80,200");
    expect(stocks?.color_rgb).toBe("40,120,60");
  });

  it("preserves server consolidated __group_val_total when grouping nav buckets", () => {
    const block: TimeseriesBlock = {
      accounts: [
        {
          account_id: -1,
          name: "Total",
          dataKey: "__group_val_total",
          valueSeriesType: "reference",
        },
        { account_id: 78, name: "AFP", dataKey: "78", valueSeriesType: "data" },
        { account_id: 46, name: "APV", dataKey: "46", valueSeriesType: "data" },
      ],
      points: [
        {
          as_of_date: "2026-05-31",
          __group_val_total: 95_680_506,
          "78": 20_000_000,
          "46": 73_283_277,
        },
      ],
    };
    const meta = {
      afp: {
        key: "retirement_afp_afc",
        accountId: -720,
        dataKey: "nav_retirement_afp_afc",
        depKey: "nav_retirement_afp_afc_dep",
        barDataKey: "pl_nav_retirement_afp_afc",
        name: "AFP + AFC",
      },
      apv: {
        key: "retirement_apv",
        accountId: -721,
        dataKey: "nav_retirement_apv",
        depKey: "nav_retirement_apv_dep",
        barDataKey: "pl_nav_retirement_apv",
        name: "APV",
      },
    };
    const out = aggregateValuationByBucket(
      block,
      [],
      ["afp", "apv"],
      meta,
      (id) => (id === 78 ? "afp" : id === 46 ? "apv" : null)
    );
    expect(out.points[0]!.__group_val_total).toBe(95_680_506);
    expect(out.points[0]!.nav_retirement_afp_afc).toBe(20_000_000);
    expect(out.points[0]!.nav_retirement_apv).toBe(73_283_277);
  });
});

describe("aggregatePerformanceByBucket", () => {
  it("propagates bucket color_rgb onto synthetic bar accounts", () => {
    const perf: GroupMonthlyPerformanceResponse = {
      unit: "clp",
      group_slug: "brokerage",
      bar_accounts: [
        { account_id: 10, name: "Fund A", bar_data_key: "pl_10" },
        { account_id: 20, name: "Stock B", bar_data_key: "pl_20" },
      ],
      points: [{ month: "2024-01", pl_10: 1000, pl_20: 500, ytd_group: 1500 }],
    };
    const listRows = [
      listRow({ id: 10, name: "Fund A", category_slug: "fintual" }),
      listRow({ id: 20, name: "Stock B", category_slug: "acciones" }),
    ];
    const meta = {
      funds: {
        key: "brokerage_mutual_funds",
        accountId: -720,
        dataKey: "nav_brokerage_mutual_funds",
        depKey: "nav_brokerage_mutual_funds_dep",
        barDataKey: "pl_nav_brokerage_mutual_funds",
        name: "Mutual funds",
        color_rgb: "120,80,200",
      },
      stocks: {
        key: "brokerage_acciones",
        accountId: -721,
        dataKey: "nav_brokerage_acciones",
        depKey: "nav_brokerage_acciones_dep",
        barDataKey: "pl_nav_brokerage_acciones",
        name: "Acciones",
        color_rgb: "40,120,60",
      },
    };

    const out = aggregatePerformanceByBucket(
      perf,
      listRows,
      ["funds", "stocks"],
      meta,
      (row) => (row.id === 10 ? "funds" : row.id === 20 ? "stocks" : null)
    );

    expect(out.bar_accounts).toEqual([
      {
        account_id: -720,
        name: "Mutual funds",
        bar_data_key: "pl_nav_brokerage_mutual_funds",
        color_rgb: "120,80,200",
      },
      {
        account_id: -721,
        name: "Acciones",
        bar_data_key: "pl_nav_brokerage_acciones",
        color_rgb: "40,120,60",
      },
    ]);
  });

  it("keeps chart-inactive accounts as individual bars when they do not map to nav buckets", () => {
    const perf: GroupMonthlyPerformanceResponse = {
      unit: "clp",
      group_slug: "brokerage_acciones",
      bar_accounts: [
        { account_id: 10, name: "SPY", bar_data_key: "pl_10", color_rgb: "200,10,10" },
        { account_id: 99, name: "OILK", bar_data_key: "pl_99", color_rgb: "10,200,10" },
      ],
      points: [
        { as_of_date: "2025-01-31", pl_10: 1000, pl_99: 500, delta_total: 1500, ytd_group: 1500 },
      ],
    };
    const listRows = [
      listRow({ id: 10, name: "SPY", category_slug: "brokerage_acciones__spy", chart_inactive: false }),
      listRow({
        id: 99,
        name: "OILK",
        category_slug: "brokerage_acciones__oilk",
        chart_inactive: true,
      }),
    ];
    const meta = {
      spy: {
        key: "brokerage_acciones__spy",
        accountId: -720,
        dataKey: "nav_spy",
        depKey: "nav_spy_dep",
        barDataKey: "pl_nav_spy",
        name: "SPY",
        color_rgb: "200,10,10",
      },
    };

    const out = aggregatePerformanceByBucket(
      perf,
      listRows,
      ["spy"],
      meta,
      (row) => (row.id === 10 ? "spy" : null)
    );

    expect(out.bar_accounts).toEqual([
      {
        account_id: -720,
        name: "SPY",
        bar_data_key: "pl_nav_spy",
        color_rgb: "200,10,10",
      },
      { account_id: 99, name: "OILK", bar_data_key: "pl_99", color_rgb: "10,200,10" },
    ]);
    expect(out.points[0]!.pl_99).toBe(500);
  });
});
