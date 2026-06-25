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
  opts?: { source_account_id?: number; name?: string }
): AccountListRow {
  return {
    id,
    name: opts?.name ?? `Account ${id}`,
    notes: null,
    created_at: "",
    category_slug: "stock",
    category_label: "stock",
    group_slug: bucketSlug,
    group_label: bucketSlug,
    bucket_slug: bucketSlug,
    chart_inactive: true,
    source_account_id: opts?.source_account_id,
  };
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
});
