import { describe, expect, it } from "vitest";
import { collectNavAccountDataKeys } from "./portfolioNavFromApi";
import { enrichNavTreeWithAllAccounts } from "./navAccountsTreeEnrich";
import type { AccountListRow, NavTreeNodeDto } from "./types";

function groupNode(slug: string, members: number[], children: NavTreeNodeDto[] = []): NavTreeNodeDto {
  return {
    node_id: slug,
    slug,
    label: slug,
    label_i18n_key: null,
    route_path: `/g/${slug}`,
    active_prefix: null,
    nav_end: false,
    show_leaf_hyphen: false,
    account_id: null,
    portfolio_group_id: 1,
    expense_account_id: null,
    expense_account_slug: null,
    asset_group_slug: slug,
    api_group: null,
    api_subgroup: null,
    color_rgb: null,
    color: null,
    kind_slug: null,
    dashboard_bucket_slug: null,
    group_kind: "bucket",
    member_account_ids: members,
    children,
  };
}

function accountLeaf(id: number): NavTreeNodeDto {
  return {
    node_id: `acc.${id}`,
    slug: `account_${id}`,
    label: `Account ${id}`,
    label_i18n_key: null,
    route_path: `/account/${id}`,
    active_prefix: null,
    nav_end: true,
    show_leaf_hyphen: true,
    account_id: id,
    portfolio_group_id: null,
    expense_account_id: null,
    expense_account_slug: null,
    asset_group_slug: null,
    api_group: null,
    api_subgroup: null,
    color_rgb: null,
    color: null,
    kind_slug: null,
    dashboard_bucket_slug: null,
    group_kind: "bucket",
    children: [],
  };
}

function listRow(
  id: number,
  bucketSlug: string,
  opts?: { name?: string; groupSlug?: string }
): AccountListRow {
  return {
    id,
    name: opts?.name ?? `Account ${id}`,
    notes: null,
    created_at: "",
    category_slug: "stock",
    category_label: "stock",
    group_slug: opts?.groupSlug ?? bucketSlug,
    group_label: bucketSlug,
    bucket_slug: bucketSlug,
    chart_inactive: true,
  };
}

/** Recursively find the group node whose slug matches, returning its account leaf ids. */
function childAccountIdsOf(root: NavTreeNodeDto, slug: string): number[] {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.slug === slug) {
      return node.children.filter((c) => c.account_id != null).map((c) => c.account_id!);
    }
    stack.push(...node.children);
  }
  return [];
}

describe("enrichNavTreeWithAllAccounts", () => {
  it("adds an account the nav left out under the deepest group that has it as a member", () => {
    // cash_eqs > cash_savings; #80 is a member of cash_savings (so of cash_eqs too), whatever its
    // asset bucket says.
    const root = groupNode("cash_eqs", [44, 80], [groupNode("cash_savings", [44, 80], [accountLeaf(44)])]);
    const enriched = enrichNavTreeWithAllAccounts(root, [
      listRow(44, "cash_eqs__cash_savings__usd"),
      listRow(80, "cash_eqs__cuenta_ahorro_vivienda"),
    ]);
    expect(childAccountIdsOf(enriched, "cash_savings")).toEqual([44, 80]);
    expect(childAccountIdsOf(enriched, "cash_eqs")).toEqual([]);
  });

  it("files retired cards under the group that has them, never by bucket slug", () => {
    // The old slug match put every hidden card under the last card group it visited.
    const root = groupNode("liabilities_credit_card", [32, 35, 42, 110], [accountLeaf(32), accountLeaf(42)]);
    const enriched = enrichNavTreeWithAllAccounts(root, [
      listRow(32, "credit_cards__credit_card"),
      listRow(35, "credit_cards__credit_card"),
      listRow(42, "credit_cards__credit_card"),
      listRow(110, "credit_cards__credit_card"),
    ]);
    expect(childAccountIdsOf(enriched, "liabilities_credit_card")).toEqual([32, 42, 35, 110]);
  });

  it("throws for an account no group of the tree has as a member", () => {
    const root = groupNode("brokerage_acciones", [85], [accountLeaf(85)]);
    expect(() => enrichNavTreeWithAllAccounts(root, [listRow(60, "brokerage_acciones__oilk")])).toThrow(
      /no group of its nav tree has it as a member/
    );
  });

  it("keeps every account already in the tree", () => {
    const root = groupNode("brokerage_acciones", [85, 86], [accountLeaf(85), accountLeaf(86)]);
    const ids = collectNavAccountDataKeys(enrichNavTreeWithAllAccounts(root, [listRow(85, "x")])).map(Number);
    expect(ids).toEqual([85, 86]);
  });
});
