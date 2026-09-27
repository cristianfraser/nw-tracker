import { describe, expect, it } from "vitest";
import type { NavTreeNodeDto } from "./types";
import {
  findBestNavNodeForPathname,
  isPortfolioStripCardNode,
  portfolioStripGroupChildren,
  portfolioStripSummaryHubs,
  resolveGroupPageApiParams,
  resolveLinkedCardNavChildren,
} from "./portfolioNavFromApi";

function navNode(partial: Partial<NavTreeNodeDto> & Pick<NavTreeNodeDto, "slug">): NavTreeNodeDto {
  return {
    node_id: partial.slug,
    slug: partial.slug,
    label: partial.slug,
    label_i18n_key: null,
    route_path: partial.route_path ?? "",
    active_prefix: partial.active_prefix ?? null,
    nav_end: false,
    show_leaf_hyphen: true,
    account_id: partial.account_id ?? null,
    portfolio_group_id: partial.portfolio_group_id ?? 1,
    expense_account_id: null,
    expense_account_slug: null,
    asset_group_slug: partial.asset_group_slug ?? null,
    api_group: partial.api_group ?? null,
    api_subgroup: partial.api_subgroup ?? null,
    color_rgb: null,
    color: null,
    kind_slug: partial.kind_slug ?? null,
    dashboard_bucket_slug: partial.dashboard_bucket_slug ?? null,
    group_kind: partial.group_kind ?? "bucket",
    ...(partial.linked_card_slugs ? { linked_card_slugs: partial.linked_card_slugs } : {}),
    children: partial.children ?? [],
  };
}

describe("resolveGroupPageApiParams", () => {
  it("uses portfolio slug for leaf group pages", () => {
    expect(
      resolveGroupPageApiParams(
        navNode({ slug: "brokerage_mutual_funds", api_group: "brokerage", api_subgroup: "mutual_funds" })
      )
    ).toEqual({ portfolio_group: "brokerage_mutual_funds" });
  });

  it("uses portfolio slug for cash_eqs nav_bucket hub", () => {
    const node = navNode({
      slug: "cash_eqs",
      route_path: "/cash_eqs",
      group_kind: "nav_bucket",
    });
    expect(resolveGroupPageApiParams(node)).toEqual({ portfolio_group: "cash_eqs" });
  });

  it("uses portfolio slug for cash_savings", () => {
    const node = navNode({
      slug: "cash_savings",
      route_path: "/cash_eqs/savings",
      active_prefix: "/cash_eqs/savings",
      asset_group_slug: "cash_eqs__cash_savings",
    });
    expect(resolveGroupPageApiParams(node)).toEqual({ portfolio_group: "cash_savings" });
  });
});

describe("isPortfolioStripCardNode", () => {
  it("accepts leaf asset buckets identified by kind_slug (cash subgroups)", () => {
    for (const slug of ["cash_savings", "checking_accounts"]) {
      expect(
        isPortfolioStripCardNode(
          navNode({
            slug,
            route_path: `/cash_eqs/${slug}`,
            asset_group_slug: `cash_eqs__${slug}`,
            kind_slug: slug,
          })
        )
      ).toBe(true);
    }
  });

  it("still rejects routable non-asset nodes (no kind_slug)", () => {
    expect(isPortfolioStripCardNode(navNode({ slug: "flows_income", route_path: "/flows/income" }))).toBe(
      false
    );
  });
});

describe("portfolioStripSummaryHubs", () => {
  const bucket = (slug: string, route_path: string) =>
    navNode({ slug, route_path, dashboard_bucket_slug: slug });
  const inversiones = navNode({
    slug: "inversiones",
    route_path: "/inversiones",
    group_kind: "nav_bucket",
    children: [bucket("brokerage", "/inversiones/brokerage"), bucket("retirement", "/inversiones/retiro")],
  });
  const cashEqs = navNode({
    slug: "cash_eqs",
    route_path: "/cash_eqs",
    group_kind: "nav_bucket",
    dashboard_bucket_slug: "cash_eqs",
    children: [
      navNode({ slug: "cash_savings", route_path: "/cash_eqs/savings", kind_slug: "cash_savings" }),
    ],
  });
  const netWorth = navNode({
    slug: "net_worth",
    route_path: "/",
    children: [bucket("real_estate", "/real_estate"), inversiones, cashEqs],
  });

  it("gives a card to exactly the hubs whose children fill row 2 in their place", () => {
    expect(portfolioStripSummaryHubs(netWorth).map((n) => n.slug)).toEqual(["inversiones"]);
    expect(portfolioStripGroupChildren(netWorth).map((n) => n.slug)).toEqual([
      "real_estate",
      "brokerage",
      "retirement",
      "cash_eqs",
    ]);
  });

  it("has none on the hub's own page, whose children are buckets", () => {
    expect(portfolioStripSummaryHubs(inversiones)).toEqual([]);
  });

  it("follows a hub spread inside a spread hub", () => {
    const outer = navNode({
      slug: "outer",
      route_path: "/outer",
      group_kind: "nav_bucket",
      children: [inversiones],
    });
    const root = navNode({ slug: "net_worth", route_path: "/", children: [outer] });
    expect(portfolioStripSummaryHubs(root).map((n) => n.slug)).toEqual(["outer", "inversiones"]);
  });
});

describe("resolveLinkedCardNavChildren", () => {
  const creditCard = navNode({
    slug: "liabilities_credit_card",
    route_path: "/liabilities/credit-card",
    asset_group_slug: "liabilities",
  });
  const roots = [
    navNode({ slug: "cash_eqs", route_path: "/cash_eqs", group_kind: "nav_bucket" }),
    navNode({ slug: "liabilities", route_path: "/liabilities", children: [creditCard] }),
  ];

  it("resolves a host's declared slug from another tree", () => {
    const host = navNode({
      slug: "cash_eqs",
      route_path: "/cash_eqs",
      group_kind: "nav_bucket",
      linked_card_slugs: ["liabilities_credit_card"],
    });
    expect(resolveLinkedCardNavChildren(host, roots).map((n) => n.slug)).toEqual([
      "liabilities_credit_card",
    ]);
  });

  it("skips unknown slugs and hosts that declare none", () => {
    const unknown = navNode({ slug: "cash_eqs", linked_card_slugs: ["nope"] });
    expect(resolveLinkedCardNavChildren(unknown, roots)).toEqual([]);
    expect(resolveLinkedCardNavChildren(navNode({ slug: "cash_eqs" }), roots)).toEqual([]);
  });
});

describe("findBestNavNodeForPathname", () => {
  it("prefers portfolio group over account when prefix scores tie", () => {
    const group = navNode({
      slug: "cash_savings",
      route_path: "/cash_eqs/savings",
      active_prefix: "/cash_eqs/savings",
      api_group: "cash_eqs",
    });
    const account = navNode({
      slug: "account_42",
      route_path: "/account/42",
      account_id: 42,
    });
    const tree = [
      navNode({
        slug: "cash_eqs",
        route_path: "/cash_eqs",
        group_kind: "nav_bucket",
        children: [group, account],
      }),
    ];
    const hit = findBestNavNodeForPathname(tree, "/cash_eqs");
    expect(hit?.slug).toBe("cash_eqs");
    expect(hit?.account_id).toBeNull();
  });

  it("resolves cash_savings on its route, not the hub", () => {
    const savings = navNode({
      slug: "cash_savings",
      route_path: "/cash_eqs/savings",
      active_prefix: "/cash_eqs/savings",
      asset_group_slug: "cash_eqs__cash_savings",
    });
    const tree = [
      navNode({
        slug: "cash_eqs",
        route_path: "/cash_eqs",
        active_prefix: "/cash_eqs",
        group_kind: "nav_bucket",
        children: [savings],
      }),
    ];
    const hit = findBestNavNodeForPathname(tree, "/cash_eqs/savings");
    expect(hit?.slug).toBe("cash_savings");
  });

  it("resolves credit-card issuer on its own route, not the parent subgroup", () => {
    const creditCard = navNode({
      slug: "liabilities_credit_card",
      route_path: "/liabilities/credit-card",
      active_prefix: "/liabilities/credit-card",
      asset_group_slug: "liabilities",
    });
    const santander = navNode({
      slug: "santander",
      route_path: "/liabilities/credit-card/santander",
      active_prefix: "/liabilities/credit-card/santander",
      asset_group_slug: "credit_cards",
      children: [
        navNode({
          slug: "cc_4242",
          route_path: "/account/1",
          account_id: 1,
          nav_end: true,
        }),
      ],
    });
    creditCard.children = [santander];
    const tree = [
      navNode({
        slug: "liabilities",
        route_path: "/liabilities",
        asset_group_slug: "liabilities",
        children: [creditCard],
      }),
    ];
    const hit = findBestNavNodeForPathname(tree, "/liabilities/credit-card/santander");
    expect(hit?.slug).toBe("santander");
  });
});
