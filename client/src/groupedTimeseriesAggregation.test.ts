import { describe, expect, it } from "vitest";
import {
  aggregatePerformanceByBucket,
  aggregatePieByBucket,
  aggregateValuationByBucket,
} from "./groupedTimeseriesAggregation";
import type { GroupMonthlyPerformanceResponse, TimeseriesBlock } from "./types";

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
      { id: 10, name: "Fund A", category_slug: "fintual" },
      { id: 20, name: "Stock B", category_slug: "acciones" },
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
});
