import { describe, expect, it } from "vitest";
import type { CardMetricsAccountRow } from "./dashboardNavCardMetrics.js";
import type { NavTreeNodeDto } from "./navTree.js";
import { buildNavValueMap, NAV_VALUE_MAP_COLOR_BOUNDS, type NavValueMapNodeDto } from "./navValueMap.js";
import type { ProxyBasketBreakdown, ProxyHoldingBreakdown } from "./proxyBasketBreakdownTypes.js";

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
    // beside accounts it is a leaf, as in the sidebar: one block, nothing to open into
    expect(ipsa.leaf_accounts).toEqual([]);
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

describe("buildNavValueMap proxy breakdown", () => {
  const perPeriod = <T,>(v: T): Record<"day" | "month" | "year", T> => ({ day: v, month: v, year: v });
  const holding = (ticker: string, weight: number, r: number | null): ProxyHoldingBreakdown => ({
    ticker,
    price_ticker: ticker,
    weight,
    pct: perPeriod({ clp: r, usd: r }),
    contribution_pct: perPeriod({ clp: r == null ? null : r * weight, usd: r == null ? null : r * weight }),
    days_held: perPeriod({ held: 3, total: 5 }),
  });
  const breakdown = (bucket: string, other_weight: number): ProxyBasketBreakdown => ({
    bucket_slug: bucket,
    positions_date: "2026-10-01",
    other_weight,
    holdings: [holding("SPXS", 0.5, 0.1), holding("FTEC", 0.3, -0.05)],
  });
  // APV frame with two leaf groups, one Fintual account each; a plain brokerage group beside.
  const tree = navNode({
    slug: "net_worth",
    children: [
      navNode({
        slug: "retirement_apv",
        children: [
          navNode({ slug: "retirement_apv_a", children: [acc(46)] }),
          navNode({ slug: "retirement_apv_b", children: [acc(47)] }),
        ],
      }),
      navNode({ slug: "brokerage", children: [acc(2)] }),
    ],
  });
  const rows = [
    row({ account_id: 46, current_value_clp: 600, current_value_usd: 0.6, delta_day_clp: 6, prior_day_close_clp: 594, deposits_day_clp: 0 }),
    row({ account_id: 47, current_value_clp: 400, current_value_usd: 0.4, delta_day_clp: 4, prior_day_close_clp: 396, deposits_day_clp: 0 }),
    row({ account_id: 2, current_value_clp: 300, current_value_usd: 0.3, delta_day_clp: -3, prior_day_close_clp: 303, deposits_day_clp: 0 }),
  ];
  const linkedCreditCards = { clp: 0, usd: 0 };
  const proxyX = {
    bucketByAccountId: new Map([[46, "x"], [47, "x"]]),
    breakdowns: new Map([["x", breakdown("x", 0.2)]]),
  };

  it("merges accounts sharing one basket into the frame's holding tiles, no double count", () => {
    const root = buildNavValueMap({ navRoot: tree, rows, linkedCreditCards, proxy: proxyX });
    const apv = root.children!.find((c) => c.slug === "retirement_apv")!;
    expect(apv.kind).toBe("group");
    expect(apv.frame).toBe(true);
    expect(apv.leaf_accounts).toBeUndefined();
    expect(apv.value_clp).toBe(1000);
    expect(apv.value_usd).toBeCloseTo(1, 10);
    expect(apv.pct.day.clp).toBeCloseTo(10 / 990, 10);
    expect(apv.pl.day.clp).toBe(10);
    expect(apv.children!.map((c) => c.slug)).toEqual(["holding_x_spxs", "holding_x_ftec", "holding_x_other"]);
    const spxs = apv.children![0]!;
    expect(spxs.kind).toBe("holding");
    expect(spxs.label).toBe("SPXS");
    expect(spxs.label_i18n_key).toBeNull();
    expect(spxs.account_id).toBeNull();
    expect(spxs.route_path).toBe("/retirement_apv");
    expect(spxs.value_clp).toBe(500);
    expect(spxs.value_usd).toBeCloseTo(0.5, 10);
    expect(spxs.pct.day.clp).toBe(0.1);
    expect(spxs.pl.day.clp).toBeCloseTo((500 * 0.1) / 1.1, 10);
    expect(spxs.pl.day.usd).toBeCloseTo((0.5 * 0.1) / 1.1, 10);
    expect(spxs.holding).toEqual({
      ticker: "SPXS",
      weight: 0.5,
      contribution_pct: perPeriod({ clp: 0.05, usd: 0.05 }),
      days_held: perPeriod({ held: 3, total: 5 }),
    });
    const ftec = apv.children![1]!;
    expect(ftec.value_clp).toBe(300);
    expect(ftec.pl.day.clp).toBeCloseTo((300 * -0.05) / 0.95, 10);
    const other = apv.children![2]!;
    expect(other.kind).toBe("holding");
    expect(other.holding).toBeNull();
    expect(other.label_i18n_key).toBe("valueMap.otherSleeve");
    expect(other.value_clp).toBe(200);
    expect(other.pct.day.clp).toBeNull();
    expect(other.pl.day.clp).toBeNull();
    // the accounts are claimed once: the root is Σ of its frames, nothing counted twice
    expect(root.value_clp).toBe(1300);
    expect(leaves(root).reduce((s, l) => s + l.value_clp, 0)).toBe(1300);
    expect(leaves(root).map((l) => l.slug)).not.toContain("retirement_apv_a");
  });

  it("accounts on different baskets break down under their own leaf groups", () => {
    const proxy = {
      bucketByAccountId: new Map([[46, "x"], [47, "y"]]),
      breakdowns: new Map([["x", breakdown("x", 0)], ["y", breakdown("y", 0.5)]]),
    };
    const root = buildNavValueMap({ navRoot: tree, rows, linkedCreditCards, proxy });
    const apv = root.children!.find((c) => c.slug === "retirement_apv")!;
    expect(apv.children!.map((c) => c.slug)).toEqual(["retirement_apv_a", "retirement_apv_b"]);
    const a = apv.children![0]!;
    expect(a.frame).toBe(true);
    expect(a.value_clp).toBe(600);
    expect(a.children!.map((c) => c.slug)).toEqual(["holding_x_spxs", "holding_x_ftec"]);
    const b = apv.children![1]!;
    expect(b.children!.map((c) => c.slug)).toEqual(["holding_y_spxs", "holding_y_other", "holding_y_ftec"]);
    expect(b.children![1]!.value_clp).toBe(200);
    expect(apv.value_clp).toBe(1000);
    expect(root.value_clp).toBe(1300);
  });

  it("a group mixing a proxied and a plain account keeps its shape", () => {
    const proxy = {
      bucketByAccountId: new Map([[46, "x"]]),
      breakdowns: new Map([["x", breakdown("x", 0.2)]]),
    };
    const root = buildNavValueMap({ navRoot: tree, rows, linkedCreditCards, proxy });
    const apv = root.children!.find((c) => c.slug === "retirement_apv")!;
    expect(apv.children!.map((c) => c.slug)).toEqual(["retirement_apv_a", "retirement_apv_b"]);
    // apv_a alone is on the basket: it breaks down by itself; apv_b stays a plain leaf tile
    expect(apv.children![0]!.children!.map((c) => c.kind)).toEqual(["holding", "holding", "holding"]);
    const b = apv.children![1]!;
    expect(b.frame).toBe(false);
    expect(b.children).toBeUndefined();
    expect(b.leaf_accounts!.map((c) => c.slug)).toEqual(["account_47"]);
    expect(root.value_clp).toBe(1300);
  });

  it("no breakdown on record for the basket, or no proxy input: unchanged", () => {
    const plain = buildNavValueMap({ navRoot: tree, rows, linkedCreditCards });
    const noBreakdown = buildNavValueMap({
      navRoot: tree,
      rows,
      linkedCreditCards,
      proxy: { bucketByAccountId: proxyX.bucketByAccountId, breakdowns: new Map() },
    });
    expect(noBreakdown).toEqual(plain);
    const apv = plain.children!.find((c) => c.slug === "retirement_apv")!;
    expect(apv.children!.map((c) => c.slug)).toEqual(["retirement_apv_a", "retirement_apv_b"]);
    expect(apv.children![0]!.leaf_accounts!.map((c) => c.slug)).toEqual(["account_46"]);
  });

  it("the «Otros» tile only when the fund has a non-ETF sleeve", () => {
    const proxy = {
      bucketByAccountId: proxyX.bucketByAccountId,
      breakdowns: new Map([["x", breakdown("x", 0)]]),
    };
    const root = buildNavValueMap({ navRoot: tree, rows, linkedCreditCards, proxy });
    const apv = root.children!.find((c) => c.slug === "retirement_apv")!;
    expect(apv.children!.map((c) => c.slug)).toEqual(["holding_x_spxs", "holding_x_ftec"]);
  });
});
