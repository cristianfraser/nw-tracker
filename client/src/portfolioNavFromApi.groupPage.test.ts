import { describe, expect, it } from "vitest";
import type { NavTreeNodeDto } from "./types";
import {
  findBestNavNodeForPathname,
  resolveGroupPageApiParams,
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
    source_account_id: null,
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
