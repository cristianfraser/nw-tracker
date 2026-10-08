import { describe, expect, it } from "vitest";
import {
  buildPlaceholderGroupPerf,
  buildPlaceholderGroupValuationBlock,
  buildPlaceholderPortfolioGroupBundle,
} from "./groupPageChartPlaceholders";
import type { AccountListRow, NavTreeNodeDto } from "../types";

const sampleAccounts: AccountListRow[] = [
  {
    id: 60,
    name: "OILK",
    notes: null,
    created_at: "2020-01-01",
    category_slug: "stock",
    category_label: "stock",
    group_slug: "brokerage_acciones",
    group_label: "Acciones",
  },
];

describe("buildPlaceholderGroupValuationBlock", () => {
  it("emits month-end points at zero per account", () => {
    const block = buildPlaceholderGroupValuationBlock(sampleAccounts);
    expect(block.accounts).toHaveLength(1);
    expect(block.points.length).toBeGreaterThan(0);
    const last = block.points[block.points.length - 1]!;
    expect(last.as_of_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(last["60"]).toBe(0);
  });
});

describe("buildPlaceholderPortfolioGroupBundle", () => {
  it("includes ts and perf when accounts are provided", () => {
    const bundle = buildPlaceholderPortfolioGroupBundle("clp", sampleAccounts, "brokerage_acciones");
    expect(bundle.accounts).toHaveLength(1);
    expect(bundle.ts.accounts_in_group?.points.length).toBeGreaterThan(0);
    expect(bundle.ts.group_allocation_proportional?.series.length).toBe(1);
    expect(bundle.groupPerf?.points.length).toBeGreaterThan(0);
    expect(bundle.groupPerf?.bar_accounts[0]?.bar_data_key).toBe("pl_60");
  });
});

function navNodeWithChartBuckets(
  chart_buckets: NonNullable<NavTreeNodeDto["chart_buckets"]>
): NavTreeNodeDto {
  return {
    node_id: "brokerage",
    slug: "brokerage",
    label: "Brokerage",
    label_i18n_key: null,
    route_path: "/inversiones/brokerage",
    active_prefix: null,
    nav_end: false,
    show_leaf_hyphen: false,
    account_id: null,
    portfolio_group_id: 7,
    expense_account_id: null,
    expense_account_slug: null,
    asset_group_slug: "brokerage",
    kind_slug: null,
    dashboard_bucket_slug: "brokerage",
    api_group: "brokerage",
    api_subgroup: null,
    color_rgb: null,
    color: null,
    group_kind: "bucket",
    chart_buckets,
    children: [],
  };
}

describe("grouped skeleton from navNode.chart_buckets", () => {
  const bucketMeta = (i: number, name: string) => ({
    data_key: `nav_${name}`,
    account_id: -720 - i,
    dep_key: `nav_${name}_dep`,
    bar_data_key: `pl_nav_${name}`,
    name,
    name_i18n_key: `brokerage.groups.${name}`,
    color_rgb: "10,20,30",
  });

  it("emits zero grouped blocks + proportional + bars with the server dataKeys", () => {
    const navNode = navNodeWithChartBuckets({
      grouped: [bucketMeta(0, "crypto"), bucketMeta(1, "mutual_funds")],
    });
    const bundle = buildPlaceholderPortfolioGroupBundle(
      "clp",
      sampleAccounts,
      "brokerage",
      undefined,
      navNode
    );

    const grouped = bundle.ts.nav_grouped_blocks?.grouped;
    expect(grouped).toBeTruthy();
    const keys = grouped!.accounts!.map((a) => a.dataKey);
    expect(keys).toEqual(["__group_val_total", "nav_crypto", "nav_mutual_funds"]);
    expect(grouped!.accounts![1]!.name_i18n_key).toBe("brokerage.groups.crypto");
    const last = grouped!.points[grouped!.points.length - 1]!;
    expect(last.nav_crypto).toBe(0);
    expect(last.__group_val_total).toBe(0);

    const shares = bundle.ts.nav_grouped_proportional;
    expect(shares?.series.map((s) => s.dataKey)).toEqual(["nav_crypto", "nav_mutual_funds"]);
    expect(shares?.series[0]?.values[0]).toBeCloseTo(0.5);

    const bars = bundle.groupPerf?.nav_grouped_bars?.grouped;
    expect(bars?.bar_accounts.map((b) => b.bar_data_key)).toEqual([
      "pl_nav_crypto",
      "pl_nav_mutual_funds",
    ]);
    expect(bars?.points[0]?.pl_nav_crypto).toBe(0);
  });

  it("emits the liab block for Pasivos nodes (no nav_grouped_blocks)", () => {
    const navNode = navNodeWithChartBuckets({
      liab: [bucketMeta(0, "santander"), bucketMeta(1, "bci")],
    });
    const bundle = buildPlaceholderPortfolioGroupBundle(
      "clp",
      sampleAccounts,
      "liabilities_credit_card",
      undefined,
      navNode
    );
    expect(bundle.ts.liab_grouped_block?.accounts?.map((a) => a.dataKey)).toEqual([
      "__group_val_total",
      "nav_santander",
      "nav_bci",
    ]);
    expect(bundle.ts.nav_grouped_blocks).toBeUndefined();
    expect(bundle.groupPerf?.liab_grouped_bars?.bar_accounts).toHaveLength(2);
  });

  it("omits grouped fields when the node has no chart_buckets", () => {
    const bundle = buildPlaceholderPortfolioGroupBundle("clp", sampleAccounts, "brokerage");
    expect(bundle.ts.nav_grouped_blocks).toBeUndefined();
    expect(bundle.ts.liab_grouped_block).toBeUndefined();
    expect(bundle.groupPerf?.nav_grouped_bars).toBeUndefined();
  });
});

describe("buildPlaceholderGroupPerf", () => {
  it("zeroes bar series and totals", () => {
    const perf = buildPlaceholderGroupPerf(sampleAccounts, "brokerage_acciones", "clp");
    const last = perf.points[perf.points.length - 1]!;
    expect(last.pl_60).toBe(0);
    expect(last.delta_total).toBe(0);
  });
});
