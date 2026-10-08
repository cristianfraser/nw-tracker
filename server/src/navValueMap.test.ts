import { describe, expect, it } from "vitest";
import type { CardMetricsAccountRow } from "./dashboardNavCardMetrics.js";
import type { NavTreeNodeDto } from "./navTree.js";
import { buildNavValueMap, NAV_VALUE_MAP_COLOR_BOUNDS, type NavValueMapNodeDto } from "./navValueMap.js";

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

const acc = (id: number) =>
  navNode({ slug: `account_${id}`, account_id: id, portfolio_group_id: null, route_path: `/account/${id}` });

function leaves(n: NavValueMapNodeDto): NavValueMapNodeDto[] {
  return n.children ? n.children.flatMap(leaves) : [n];
}

describe("buildNavValueMap", () => {
  const tree = navNode({
    slug: "net_worth",
    children: [
      navNode({ slug: "real_estate", children: [acc(1)] }),
      navNode({
        slug: "brokerage_hub",
        group_kind: "nav_bucket",
        children: [
          // mixed group: accounts beside sub-buckets
          navNode({
            slug: "acciones",
            children: [acc(2), acc(3), navNode({ slug: "ipsa", children: [acc(4), acc(5)] })],
          }),
          navNode({ slug: "crypto", children: [acc(6)] }),
          navNode({ slug: "empty_group", children: [acc(7)] }),
        ],
      }),
      navNode({ slug: "liabilities", group_kind: "liability_group", children: [acc(8)] }),
      navNode({ slug: "ref", group_kind: "reference", children: [] }),
    ],
  });
  const rows = [
    row({ account_id: 1, current_value_clp: 1000, current_value_usd: 1, delta_day_clp: 10, prior_day_close_clp: 990, deposits_day_clp: 0 }),
    row({ account_id: 2, current_value_clp: 300, current_value_usd: 0.3, delta_day_clp: -3, prior_day_close_clp: 303, deposits_day_clp: 0 }),
    row({ account_id: 3, current_value_clp: -50, delta_day_clp: -1 }), // negative: dropped
    row({ account_id: 4, current_value_clp: 200, current_value_usd: 0.2, delta_day_clp: 2, prior_day_close_clp: 198, deposits_day_clp: 0 }),
    row({ account_id: 5, current_value_clp: 100, current_value_usd: 0.1, delta_day_clp: 1, prior_day_close_clp: 99, deposits_day_clp: 0 }),
    row({ account_id: 6, current_value_clp: 150, delta_day_clp: 0, prior_day_close_clp: 150, deposits_day_clp: 0 }),
    row({ account_id: 7, current_value_clp: 0 }), // empty group: dropped
    row({ account_id: 8, current_value_clp: 5000 }), // liabilities: not in the map
  ];
  const linkedCreditCards = { clp: 0, usd: 0 };

  it("frames hold group children; leaf groups are tiles; mixed groups show their accounts", () => {
    const root = buildNavValueMap({ navRoot: tree, rows, linkedCreditCards });
    expect(root.frame).toBe(true);
    expect(root.children!.map((c) => c.slug).sort()).toEqual(["brokerage_hub", "real_estate"]);
    const hub = root.children!.find((c) => c.slug === "brokerage_hub")!;
    expect(hub.frame).toBe(true);
    const acciones = hub.children!.find((c) => c.slug === "acciones")!;
    expect(acciones.frame).toBe(true);
    expect(acciones.children!.map((c) => c.slug).sort()).toEqual(["account_2", "ipsa"]);
    const ipsa = acciones.children!.find((c) => c.slug === "ipsa")!;
    expect(ipsa.frame).toBe(false);
    expect(ipsa.children).toBeUndefined(); // accounts inside a leaf group are not shown
    expect(ipsa.value_clp).toBe(300);
    // a leaf group is a tile that carries its accounts, for the page whose first level it is
    const crypto = hub.children!.find((c) => c.slug === "crypto")!;
    expect(crypto.frame).toBe(false);
    expect(crypto.children).toBeUndefined();
    expect(crypto.leaf_accounts!.map((c) => c.slug)).toEqual(["account_6"]);
    const re = root.children!.find((c) => c.slug === "real_estate")!;
    expect(re.frame).toBe(false);
    expect(re.leaf_accounts!.map((c) => c.slug)).toEqual(["account_1"]);
    expect(re.value_clp).toBe(1000);
  });

  it("hides non-positive nodes but still counts them, leaves liabilities out, no double counting", () => {
    const root = buildNavValueMap({ navRoot: tree, rows, linkedCreditCards });
    const slugs = leaves(root).map((l) => l.slug);
    expect(slugs).not.toContain("empty_group");
    expect(slugs).not.toContain("account_3");
    expect(slugs).not.toContain("liabilities");
    expect(new Set(slugs).size).toBe(slugs.length);
    // the hidden −50 account still counts in its frame and every ancestor
    expect(root.value_clp).toBe(1000 + 300 - 50 + 300 + 150);
    expect(leaves(root).reduce((s, l) => s + l.value_clp, 0)).toBe(root.value_clp + 50);
    const acciones = root.children!.find((c) => c.slug === "brokerage_hub")!.children!.find((c) => c.slug === "acciones")!;
    expect(acciones.value_clp).toBe(300 - 50 + 300);
    expect(root.value_usd).toBeNull(); // account 6 has no usd value
  });

  it("colours by the node's own flow-adjusted % and carries the period P/L", () => {
    const root = buildNavValueMap({ navRoot: tree, rows, linkedCreditCards });
    const a2 = leaves(root).find((l) => l.slug === "account_2")!;
    expect(a2.pct.day.clp).toBeCloseTo(-3 / 303, 10);
    expect(a2.pl.day.clp).toBe(-3);
    const ipsa = leaves(root).find((l) => l.slug === "ipsa")!;
    expect(ipsa.pct.day.clp).toBeCloseTo(3 / 297, 10);
    expect(ipsa.pl.day.clp).toBe(3);
    expect(NAV_VALUE_MAP_COLOR_BOUNDS).toEqual({ day: 0.03, month: 0.08, year: 0.25 });
  });

  it("nets the linked credit cards into the savings tile only", () => {
    const cashTree = navNode({
      slug: "net_worth",
      children: [
        navNode({
          slug: "cash_eqs",
          group_kind: "nav_bucket",
          dashboard_bucket_slug: "cash_eqs",
          children: [
            navNode({ slug: "cash_savings", asset_group_slug: "cash_eqs__cash_savings", children: [acc(21)] }),
            navNode({ slug: "checking_accounts", children: [acc(22)] }),
          ],
        }),
      ],
    });
    const cashRows = [
      row({ account_id: 21, current_value_clp: 1000, current_value_usd: 1, bucket_slug: "cash_eqs__a", dashboard_bucket_slug: "cash_eqs" }),
      row({ account_id: 22, current_value_clp: 500, current_value_usd: 0.5, bucket_slug: "cash_eqs__b", dashboard_bucket_slug: "cash_eqs" }),
    ];
    const root = buildNavValueMap({ navRoot: cashTree, rows: cashRows, linkedCreditCards: { clp: 400, usd: 0.4 } });
    const cash = root.children![0]!;
    expect(cash.children!.find((c) => c.slug === "cash_savings")!.value_clp).toBe(600);
    expect(cash.children!.find((c) => c.slug === "checking_accounts")!.value_clp).toBe(500);
    expect(cash.value_clp).toBe(1100); // = Σ accounts − linked cards, the card's own value
    expect(cash.value_usd).toBeCloseTo(1.1, 10);
    // a card bigger than savings + checking makes the whole cash bucket negative: hidden whole,
    // even though checking alone is positive
    const over = buildNavValueMap({
      navRoot: navNode({ slug: "net_worth", children: [cashTree.children![0]!, navNode({ slug: "real_estate", children: [acc(23)] })] }),
      rows: [...cashRows, row({ account_id: 23, current_value_clp: 5000 })],
      linkedCreditCards: { clp: 2000, usd: 2 },
    });
    expect(over.children!.map((c) => c.slug)).toEqual(["real_estate"]);
    expect(over.value_clp).toBe(5000 + 1500 - 2000);
  });

  it("excluded-from-totals accounts are not tiles", () => {
    const out = buildNavValueMap({
      navRoot: tree,
      rows: rows.map((r) => (r.account_id === 1 ? { ...r, exclude_from_group_totals: 1 } : r)),
      linkedCreditCards,
    });
    expect(leaves(out).map((l) => l.slug)).not.toContain("real_estate");
  });
});
