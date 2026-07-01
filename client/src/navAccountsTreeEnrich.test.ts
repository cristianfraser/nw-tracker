import { describe, expect, it } from "vitest";
import { collectNavAccountDataKeys } from "./portfolioNavFromApi";
import { enrichNavTreeWithAllAccounts } from "./navAccountsTreeEnrich";
import type { AccountListRow, NavTreeNodeDto } from "./types";

function groupNode(slug: string, children: NavTreeNodeDto[] = []): NavTreeNodeDto {
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
    source_account_id: null,
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
    source_account_id: null,
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
  opts?: { source_account_id?: number; name?: string; groupSlug?: string }
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
    source_account_id: opts?.source_account_id,
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
  it("appends chart-inactive accounts missing from sidebar nav", () => {
    const root = groupNode("brokerage_acciones", [accountLeaf(85), accountLeaf(86)]);
    const enriched = enrichNavTreeWithAllAccounts(root, [
      listRow(85, "brokerage_acciones__spy"),
      listRow(60, "brokerage_acciones__oilk"),
    ]);
    const ids = collectNavAccountDataKeys(enriched).map(Number);
    expect(ids).toContain(85);
    expect(ids).toContain(60);
  });

  it("places a chart-inactive account in its portfolio sub-bucket via group_slug", () => {
    // cash_eqs > cash_savings; account #80 lives under cash_savings (portfolio group slug),
    // but its asset bucket is cash_eqs__cuenta_ahorro_vivienda. It must land under cash_savings,
    // not directly under cash_eqs.
    const root = groupNode("cash_eqs", [groupNode("cash_savings", [accountLeaf(44)])]);
    const enriched = enrichNavTreeWithAllAccounts(root, [
      listRow(80, "cash_eqs__cuenta_ahorro_vivienda", { groupSlug: "cash_savings" }),
    ]);
    expect(childAccountIdsOf(enriched, "cash_savings")).toContain(80);
    expect(childAccountIdsOf(enriched, "cash_eqs")).not.toContain(80);
  });
});
