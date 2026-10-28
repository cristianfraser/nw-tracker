import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  accountCountsTowardGroupTotals,
  buildNavCardMetricsBySlug,
  cardMetricsFromRows,
  liquidatedRowsForNode,
  navMetricsAccountIdSet,
  stripMetricsRows,
  sumCardMetrics,
  type CardMetricsAccountRow,
  type NavCardBucketTotals,
  type NavCardMetricsBuildInput,
} from "./dashboardNavCardMetrics.js";
import type { NavTreeNodeDto } from "./navTree.js";

function row(partial: Partial<CardMetricsAccountRow> & { account_id: number }): CardMetricsAccountRow {
  return {
    group_slug: "brokerage",
    bucket_slug: "brokerage",
    dashboard_bucket_slug: "brokerage",
    chart_inactive: false,
    exclude_from_group_totals: 0,
    deposits_clp: 0,
    deposits_usd: null,
    delta_total_clp: null,
    delta_total_usd: null,
    deposits_month_clp: 0,
    deposits_month_usd: null,
    deposits_year_clp: 0,
    deposits_year_usd: null,
    delta_month_clp: null,
    delta_month_usd: null,
    delta_year_clp: null,
    delta_year_usd: null,
    current_value_clp: 0,
    current_value_usd: null,
    ...partial,
  };
}

function navNode(partial: Partial<NavTreeNodeDto> & { slug: string }): NavTreeNodeDto {
  return {
    node_id: `test-${partial.slug}`,
    label: partial.slug,
    label_i18n_key: null,
    route_path: `/${partial.slug}`,
    active_prefix: null,
    nav_end: false,
    show_leaf_hyphen: true,
    account_id: null,
    portfolio_group_id: 1,
    expense_account_id: null,
    expense_account_slug: null,
    asset_group_slug: null,
    api_group: null,
    api_subgroup: null,
    color_rgb: null,
    color: null,
    kind_slug: null,
    dashboard_bucket_slug: null,
    exclude_from_parent_total: false,
    group_kind: "bucket",
    children: [],
    ...partial,
  };
}

type CountsCase = { exclude_from_group_totals: number | null | "absent"; counts: boolean };
const countsCases = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "test",
      "accountCountsTowardGroupTotalsCases.json"
    ),
    "utf-8"
  )
) as CountsCase[];

const NO_BUCKETS: NavCardBucketTotals = {
  real_estate_clp: 0,
  retirement_clp: 0,
  brokerage_clp: 0,
  cash_eqs_clp: 0,
};

function accountLeaf(slug: string, accountId: number): NavTreeNodeDto {
  return navNode({ slug, account_id: accountId, portfolio_group_id: null });
}

describe("cardMetricsFromRows", () => {
  it("null-vs-0 semantics match the client: no contributing rows → null deltas, 0 deposits", () => {
    const m = cardMetricsFromRows([], "month");
    expect(m).toEqual({
      deposits_clp: 0,
      deposits_usd: null,
      delta_total_clp: null,
      delta_total_usd: null,
      deposits_period_clp: 0,
      deposits_period_usd: null,
      delta_period_clp: null,
      delta_period_usd: null,
    });
  });

  it("sums period fields by period and keeps usd null until a row contributes", () => {
    const rows = [
      row({
        account_id: 1,
        deposits_clp: 100,
        deposits_month_clp: 10,
        deposits_year_clp: 40,
        delta_month_clp: 5,
        delta_year_clp: 20,
        delta_total_clp: 50,
      }),
      row({
        account_id: 2,
        deposits_clp: 200,
        deposits_month_clp: 30,
        deposits_year_clp: 60,
        delta_month_clp: -2,
        delta_year_clp: 8,
        delta_total_clp: 25,
        deposits_usd: 3,
      }),
    ];
    const month = cardMetricsFromRows(rows, "month");
    expect(month.deposits_clp).toBe(300);
    expect(month.deposits_usd).toBe(3);
    expect(month.deposits_period_clp).toBe(40);
    expect(month.delta_period_clp).toBe(3);
    expect(month.delta_total_clp).toBe(75);
    expect(month.delta_period_usd).toBeNull();
    const year = cardMetricsFromRows(rows, "year");
    expect(year.deposits_period_clp).toBe(100);
    expect(year.delta_period_clp).toBe(28);
  });
});

describe("sumCardMetrics", () => {
  it("propagates null only when no part contributes", () => {
    const a = cardMetricsFromRows([row({ account_id: 1, delta_month_clp: 7 })], "month");
    const b = cardMetricsFromRows([row({ account_id: 2 })], "month");
    const sum = sumCardMetrics([a, b]);
    expect(sum.delta_period_clp).toBe(7);
    expect(sum.delta_period_usd).toBeNull();
    expect(sum.delta_total_clp).toBeNull();
  });
});

describe("navMetricsAccountIdSet", () => {
  it("covers a node's nav leaves plus the members its subtree lists, never slug-prefix matches", () => {
    const ipsa = navNode({
      slug: "brokerage_portafolio_ipsa",
      chart_inactive: true,
      member_account_ids: [101, 102],
      children: [],
    });
    const acciones = navNode({
      slug: "brokerage_acciones",
      asset_group_slug: "brokerage_acciones",
      member_account_ids: [10, 101, 102],
      children: [ipsa, accountLeaf("acc-10", 10)],
    });
    expect([...navMetricsAccountIdSet(ipsa)].sort()).toEqual([101, 102]);
    expect([...navMetricsAccountIdSet(acciones)].sort()).toEqual([10, 101, 102]);
    const rows = [
      row({ account_id: 10, bucket_slug: "brokerage_acciones__spy", deposits_month_clp: 0 }),
      row({ account_id: 101, bucket_slug: "brokerage_acciones__cfietfipsa_sn", chart_inactive: true, deposits_month_clp: -2_992_723, delta_month_clp: -23_042 }),
      row({ account_id: 102, bucket_slug: "brokerage_cash__caja_portafolio_ipsa__clp", chart_inactive: true, deposits_month_clp: -38_436, delta_month_clp: -2_579 }),
      row({ account_id: 7, bucket_slug: "brokerage_acciones__stray", chart_inactive: true, deposits_month_clp: -1 }),
    ];
    expect(stripMetricsRows(ipsa, rows).map((r) => r.account_id)).toEqual([101, 102]);
    // The stray row's slug starts with the node's asset group; membership alone decides.
    expect(stripMetricsRows(acciones, rows).map((r) => r.account_id)).toEqual([10, 101, 102]);
    const metrics = buildNavCardMetricsBySlug({ navRoots: [acciones], rows, bucketTotals: NO_BUCKETS });
    expect(metrics.brokerage_portafolio_ipsa!.child.month.deposits_period_clp).toBe(-3_031_159);
    expect(metrics.brokerage_portafolio_ipsa!.child.month.delta_period_clp).toBe(-25_621);
    expect(metrics.brokerage_acciones!.child.month.deposits_period_clp).toBe(-3_031_159);
  });
});

describe("liquidatedRowsForNode", () => {
  const ipsa = navNode({
    slug: "brokerage_portafolio_ipsa",
    chart_inactive: true,
    member_account_ids: [101, 102],
  });
  const acciones = navNode({
    slug: "brokerage_acciones",
    member_account_ids: [10, 20, 30, 101, 102],
    children: [ipsa, accountLeaf("acc-10", 10)],
  });
  const rows = [
    row({ account_id: 10, current_value_clp: 500, deposits_clp: 400, delta_total_clp: 100 }),
    // Sold out last year: no period activity left, still a liquidated row (Total stays complete).
    row({ account_id: 20, chart_inactive: true, deposits_clp: 150_000, delta_total_clp: -150_000 }),
    // Never held money: not a liquidated row.
    row({ account_id: 30, chart_inactive: true }),
    row({ account_id: 101, chart_inactive: true, deposits_clp: -30_000, delta_total_clp: 30_000, deposits_month_clp: -1_500_000, delta_month_clp: -12_000 }),
    row({ account_id: 102, chart_inactive: true, deposits_clp: -1_000, delta_total_clp: 1_000, deposits_month_clp: -20_000, delta_month_clp: -1_500 }),
  ];

  it("lists the inactive sub-bucket beside accounts and every once-funded inactive account, summing them", () => {
    const liquidated = liquidatedRowsForNode(acciones, rows)!;
    expect(liquidated.group_slugs).toEqual(["brokerage_portafolio_ipsa"]);
    expect(liquidated.account_ids).toEqual([20]);
    expect(liquidated.metrics.month.deposits_period_clp).toBe(-1_520_000);
    expect(liquidated.metrics.month.delta_period_clp).toBe(-13_500);
    expect(liquidated.metrics.month.deposits_clp).toBe(150_000 - 30_000 - 1_000);
    expect(liquidated.metrics.month.delta_total_clp).toBe(-150_000 + 30_000 + 1_000);
    const entry = buildNavCardMetricsBySlug({ navRoots: [acciones], rows, bucketTotals: NO_BUCKETS }).brokerage_acciones!;
    expect(entry.liquidated).toEqual(liquidated);
  });

  it("is absent when nothing is liquidated", () => {
    const active = rows.filter((r) => r.account_id === 10);
    const node = navNode({ slug: "solo", member_account_ids: [10], children: [accountLeaf("acc-10", 10)] });
    expect(liquidatedRowsForNode(node, active)).toBeNull();
    expect(buildNavCardMetricsBySlug({ navRoots: [node], rows: active, bucketTotals: NO_BUCKETS }).solo!.liquidated).toBeUndefined();
  });
});

describe("buildNavCardMetricsBySlug", () => {
  const brokerageRows = [
    row({
      account_id: 11,
      deposits_clp: 800,
      deposits_month_clp: 50,
      delta_month_clp: 60,
      delta_total_clp: 300,
      current_value_clp: 1100,
    }),
    // excluded from totals — must not count anywhere
    row({ account_id: 12, deposits_clp: 999, exclude_from_group_totals: 1, delta_month_clp: 999 }),
  ];

  const tree = navNode({
    slug: "net_worth",
    children: [
      navNode({
        slug: "brokerage",
        dashboard_bucket_slug: "brokerage",
        children: [accountLeaf("acc-11", 11)],
      }),
    ],
  });

  const input: NavCardMetricsBuildInput = {
    navRoots: [tree],
    rows: brokerageRows,
    bucketTotals: NO_BUCKETS,
  };

  it("full-bucket child: bucket scope excludes non-counting rows; every variant carries all three period slices", () => {
    const out = buildNavCardMetricsBySlug(input);
    const brokerage = out.brokerage!;
    expect(brokerage.child.month.deposits_clp).toBe(800);
    expect(brokerage.child.month.delta_period_clp).toBe(60);
    // rows carry no day/year fields → those slices are present but empty
    expect(brokerage.child.day.deposits_period_clp).toBe(0);
    expect(brokerage.child.day.delta_period_clp).toBeNull();
    expect(brokerage.child.year.delta_period_clp).toBeNull();
    // lifetime fields are identical across slices
    expect(brokerage.child.day.deposits_clp).toBe(800);
    expect(brokerage.child.year.deposits_clp).toBe(800);
  });

  it("day period: metrics from day row fields", () => {
    const dayRows = [
      row({
        account_id: 11,
        deposits_clp: 800,
        deposits_day_clp: 5,
        delta_day_clp: 15,
        current_value_clp: 1100,
      }),
      row({ account_id: 12, exclude_from_group_totals: 1, delta_day_clp: 999 }),
    ];
    const out = buildNavCardMetricsBySlug({ ...input, rows: dayRows });
    const brokerage = out.brokerage!;
    expect(brokerage.child.day.deposits_period_clp).toBe(5);
    expect(brokerage.child.day.delta_period_clp).toBe(15);
    const root = out.net_worth!;
    expect(root.parent.day.delta_period_clp).toBe(15);
  });

  it("net_worth root parent: sums strip-children child metrics", () => {
    const out = buildNavCardMetricsBySlug(input);
    const root = out.net_worth!;
    expect(root.parent.month.deposits_clp).toBe(800);
    expect(root.parent.month.delta_period_clp).toBe(60);
  });

  it("subtree child (no bucket mapping): metrics from nav-subtree rows only", () => {
    const subtree = navNode({
      slug: "net_worth",
      children: [
        navNode({
          slug: "brokerage_mutual_funds",
          api_group: "brokerage",
          api_subgroup: "mutual_funds",
          children: [accountLeaf("acc-11", 11)],
        }),
      ],
    });
    const out = buildNavCardMetricsBySlug({ ...input, navRoots: [subtree] });
    const mf = out.brokerage_mutual_funds!;
    expect(mf.child.month.deposits_clp).toBe(800);
    expect(mf.child.month.delta_period_clp).toBe(60);
  });

  it("walks extra roots: liability nodes get subset entries; the shared liabilities slug uses the Pasivos root", () => {
    const liabRow = row({
      account_id: 31,
      group_slug: "liabilities",
      bucket_slug: "liabilities__credit_card",
      dashboard_bucket_slug: "",
      deposits_clp: 0,
      delta_month_clp: -12_000,
      current_value_clp: -500_000,
    });
    const liabilitiesRoot = navNode({
      slug: "liabilities",
      group_kind: "liability_group",
      asset_group_slug: "liabilities",
      children: [
        navNode({
          slug: "liabilities_credit_card",
          group_kind: "liability_group",
          asset_group_slug: "liabilities",
          children: [accountLeaf("acc-31", 31)],
        }),
      ],
    });
    const out = buildNavCardMetricsBySlug({
      ...input,
      navRoots: [tree, liabilitiesRoot],
      rows: [...brokerageRows, liabRow],
    });
    const cc = out.liabilities_credit_card!;
    expect(cc.child.month.delta_period_clp).toBe(-12_000);
    // shared slug: the later (Pasivos) root's composition wins
    const liab = out.liabilities!;
    expect(liab.parent.month.delta_period_clp).toBe(-12_000);
  });

  it("cash_eqs bucket delta_period sums every cash row, checking included", () => {
    const cashRows = [
      row({
        account_id: 21,
        group_slug: "cash_eqs",
        bucket_slug: "cash_eqs__cash_savings",
        dashboard_bucket_slug: "cash_eqs",
        deposits_clp: 100,
        delta_month_clp: 4,
      }),
      row({
        account_id: 22,
        group_slug: "cash_eqs",
        bucket_slug: "cash_eqs__cuenta_corriente",
        dashboard_bucket_slug: "cash_eqs",
        deposits_clp: 50,
        delta_month_clp: 0,
      }),
      row({
        account_id: 23,
        group_slug: "cash_eqs",
        bucket_slug: "cash_eqs__checking_accounts__vitest_bank__usd",
        dashboard_bucket_slug: "cash_eqs",
        deposits_clp: 0,
        delta_month_clp: 30,
      }),
    ];
    const cashTree = navNode({
      slug: "net_worth",
      children: [
        navNode({
          slug: "cash_savings",
          dashboard_bucket_slug: "cash_eqs",
          children: [accountLeaf("acc-21", 21)],
        }),
      ],
    });
    const out = buildNavCardMetricsBySlug({ ...input, navRoots: [cashTree], rows: cashRows });
    const cash = out.cash_savings!;
    expect(cash.child.month.deposits_clp).toBe(150);
    expect(cash.child.month.delta_period_clp).toBe(34);
  });
});

describe("accountCountsTowardGroupTotals", () => {
  // Shared with the client's visibility filter (client/src/accountGroupTotals.test.ts).
  it.each(countsCases)("exclude_from_group_totals=$exclude_from_group_totals → $counts", (c) => {
    const r =
      c.exclude_from_group_totals === "absent"
        ? row({ account_id: 1, exclude_from_group_totals: undefined })
        : row({ account_id: 1, exclude_from_group_totals: c.exclude_from_group_totals });
    expect(accountCountsTowardGroupTotals(r)).toBe(c.counts);
  });
});

describe("nav card value", () => {
  const cashRows = [
    row({ account_id: 21, group_slug: "cash_eqs", dashboard_bucket_slug: "cash_eqs", current_value_clp: 3_000, current_value_usd: 3 }),
    row({ account_id: 22, group_slug: "cash_eqs", dashboard_bucket_slug: "cash_eqs", current_value_clp: 200, current_value_usd: 0.2, sync_stale: true }),
    row({ account_id: 11, current_value_clp: 1_100, current_value_usd: 1.1, fx_missing: true }),
    row({ account_id: 12, current_value_clp: 900, current_value_usd: 0.9, exclude_from_group_totals: 1 }),
  ];
  const cashSavings = navNode({
    slug: "cash_savings",
    dashboard_bucket_slug: "cash_eqs",
    children: [accountLeaf("acc-21", 21)],
  });
  const checking = navNode({
    slug: "checking_accounts",
    asset_group_slug: "cash_eqs__checking",
    children: [accountLeaf("acc-22", 22)],
  });
  const cashHub = navNode({
    slug: "cash_eqs",
    group_kind: "nav_bucket",
    dashboard_bucket_slug: "cash_eqs",
    children: [cashSavings, checking],
  });
  const brokerage = navNode({
    slug: "brokerage",
    dashboard_bucket_slug: "brokerage",
    children: [accountLeaf("acc-11", 11), accountLeaf("acc-12", 12)],
  });
  const mf = navNode({
    slug: "brokerage_mutual_funds",
    api_group: "brokerage",
    api_subgroup: "mutual_funds",
    member_account_ids: [11, 12],
    children: [accountLeaf("acc-11", 11), accountLeaf("acc-12", 12)],
  });
  const root = navNode({ slug: "net_worth", children: [brokerage, cashHub, mf] });
  // The cash bucket nets a linked card owing 9 000: the bucket total is what the cards read.
  const bucketTotals: NavCardBucketTotals = {
    real_estate_clp: 0,
    retirement_clp: 0,
    brokerage_clp: 1_100,
    cash_eqs_clp: 3_200 - 9_000,
    real_estate_usd: 0,
    retirement_usd: 0,
    brokerage_usd: 1.1,
    cash_eqs_usd: 3.2 - 9,
  };
  const out = buildNavCardMetricsBySlug({ navRoots: [root], rows: cashRows, bucketTotals });

  it("a cash child's card shows the netted bucket total; its breakdown line the raw members", () => {
    const v = out.cash_savings!.value;
    expect(v.child).toEqual({ clp: -5_800, usd: 3.2 - 9 });
    // the hub is the bucket too
    expect(out.cash_eqs!.value.child).toEqual({ clp: -5_800, usd: 3.2 - 9 });
    expect(v.members).toEqual({ clp: 3_000, usd: 3 });
  });

  it("a bucket's own node reads the bucket total in both variants", () => {
    expect(out.brokerage!.value.child).toEqual({ clp: 1_100, usd: 1.1 });
    expect(out.brokerage!.value.parent).toEqual({ clp: 1_100, usd: 1.1 });
    // members leave the row excluded from group totals out
    expect(out.brokerage!.value.members).toEqual({ clp: 1_100, usd: 1.1 });
  });

  it("net worth's summary card sums the bucket totals", () => {
    const parent = out.net_worth!.value.parent;
    expect(parent.clp).toBe(1_100 + 3_200 - 9_000);
    expect(parent.usd).toBeCloseTo(1.1 + 3.2 - 9, 10);
  });

  it("a node with no bucket sums its rows: counted ones for the card, every one for its page", () => {
    const v = out.brokerage_mutual_funds!.value;
    expect(v.child).toEqual({ clp: 1_100, usd: 1.1 });
    expect(v.parent).toEqual({ clp: 2_000, usd: 2 });
    expect(v.fx_missing).toBe(true);
    expect(v.sync_stale).toBe(false);
    expect(out.checking_accounts!.value.sync_stale).toBe(true);
  });

  it("usd is null when no row carries a dollar value", () => {
    const clpOnly = cashRows.map((r) => ({ ...r, current_value_usd: null }));
    const v = buildNavCardMetricsBySlug({ navRoots: [root], rows: clpOnly, bucketTotals: NO_BUCKETS })
      .brokerage_mutual_funds!.value;
    expect(v.child).toEqual({ clp: 1_100, usd: null });
  });

  it("the liquidated row sums its counted rows' balances", () => {
    const ipsa = navNode({ slug: "ipsa", chart_inactive: true, member_account_ids: [101] });
    const acciones = navNode({
      slug: "acciones",
      member_account_ids: [10, 20, 101],
      children: [ipsa, accountLeaf("acc-10", 10)],
    });
    const rows = [
      row({ account_id: 10, current_value_clp: 500, current_value_usd: 0.5 }),
      row({ account_id: 20, chart_inactive: true, deposits_clp: 10, current_value_clp: 7, current_value_usd: 0.007, fx_missing: true }),
      row({ account_id: 101, chart_inactive: true, deposits_clp: 5, current_value_clp: 3, current_value_usd: 0.003 }),
    ];
    const liquidated = liquidatedRowsForNode(acciones, rows)!;
    expect(liquidated.value.clp).toBe(10);
    expect(liquidated.value.usd).toBeCloseTo(0.01, 10);
    expect(liquidated.value.fx_missing).toBe(true);
  });
});
