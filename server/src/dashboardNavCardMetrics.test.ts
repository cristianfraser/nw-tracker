import { describe, expect, it } from "vitest";
import {
  buildNavCardMetricsBySlug,
  cardMetricsFromRows,
  sumCardMetrics,
  type CardMetricsAccountRow,
  type NavCardMetricsBuildInput,
} from "./dashboardNavCardMetrics.js";
import type { NavTreeNodeDto } from "./navTree.js";

function row(partial: Partial<CardMetricsAccountRow> & { account_id: number }): CardMetricsAccountRow {
  return {
    group_slug: "brokerage",
    bucket_slug: "brokerage",
    dashboard_bucket_slug: "brokerage",
    category_slug: "stock",
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
    prior_month_close_clp: null,
    prior_month_close_usd: null,
    prior_year_close_clp: null,
    prior_year_close_usd: null,
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
    source_account_id: null,
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

describe("buildNavCardMetricsBySlug", () => {
  const totals = {
    real_estate_clp: 0,
    retirement_clp: 0,
    brokerage_clp: 1100,
    cash_eqs_clp: 500,
    prior_closes: {
      month_end: "2026-06-30",
      month: { brokerage_clp: 1000, cash_eqs_clp: 490, real_estate_clp: 0, retirement_clp: 0 },
      year: { brokerage_clp: 900, cash_eqs_clp: 450, real_estate_clp: 0, retirement_clp: 0 },
    },
  };

  const brokerageRows = [
    row({
      account_id: 11,
      deposits_clp: 800,
      deposits_month_clp: 50,
      delta_month_clp: 60,
      delta_total_clp: 300,
      current_value_clp: 1100,
      prior_month_close_clp: 1000,
      prior_year_close_clp: 900,
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
    totals,
    inversiones: null,
  };

  it("full-bucket child: bucket scope excludes non-counting rows; title from totals prior closes", () => {
    const out = buildNavCardMetricsBySlug(input);
    const brokerage = out.brokerage!;
    expect(brokerage.child.month.deposits_clp).toBe(800);
    expect(brokerage.child.month.delta_period_clp).toBe(60);
    // totals-based title delta: 1100 − 1000
    expect(brokerage.child.title_delta.month_clp).toBe(100);
    expect(brokerage.child.title_delta.year_clp).toBe(200);
    // usd side has no data anywhere → null
    expect(brokerage.child.title_delta.month_usd).toBeNull();
  });

  it("net_worth root parent: sums strip-children child metrics; title = Σ bucket totals deltas", () => {
    const out = buildNavCardMetricsBySlug(input);
    const root = out.net_worth!;
    expect(root.parent.month.deposits_clp).toBe(800);
    // title over the 4 NW buckets; only brokerage + cash_eqs have prior closes ≠ current
    expect(root.parent.title_delta.month_clp).toBe(100 + 10);
    expect(root.parent.title_delta.year_clp).toBe(200 + 50);
  });

  it("subtree child (no bucket mapping): metrics and title from nav-subtree rows only", () => {
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
    // subset title: current 1100 − prior 1000 from the row itself
    expect(mf.child.title_delta.month_clp).toBe(100);
  });

  it("walks extra roots: liability nodes get subset entries; the shared liabilities slug uses the Pasivos root", () => {
    const liabRow = row({
      account_id: 31,
      group_slug: "liabilities",
      bucket_slug: "liabilities__credit_card",
      dashboard_bucket_slug: "",
      category_slug: "credit_card",
      deposits_clp: 0,
      delta_month_clp: -12_000,
      current_value_clp: -500_000,
      prior_month_close_clp: -488_000,
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
    expect(cc.child.title_delta.month_clp).toBe(-12_000);
    // shared slug: the later (Pasivos) root's composition wins
    const liab = out.liabilities!;
    expect(liab.parent.month.delta_period_clp).toBe(-12_000);
  });

  it("cash_eqs bucket delta_period comes from savings rows only (checking excluded)", () => {
    const cashRows = [
      row({
        account_id: 21,
        group_slug: "cash_eqs",
        bucket_slug: "cash_eqs__cash_savings",
        dashboard_bucket_slug: "cash_eqs",
        category_slug: "cash_savings",
        deposits_clp: 100,
        delta_month_clp: 4,
      }),
      row({
        account_id: 22,
        group_slug: "cash_eqs",
        bucket_slug: "cash_eqs__checking_accounts",
        dashboard_bucket_slug: "cash_eqs",
        category_slug: "cuenta_corriente",
        deposits_clp: 50,
        delta_month_clp: 1000,
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
    const out = buildNavCardMetricsBySlug({
      ...input,
      navRoots: [cashTree],
      rows: cashRows,
    });
    const cash = out.cash_savings!;
    // deposits: whole cash_eqs bucket (both rows); delta_period: savings row only
    expect(cash.child.month.deposits_clp).toBe(150);
    expect(cash.child.month.delta_period_clp).toBe(4);
  });
});
