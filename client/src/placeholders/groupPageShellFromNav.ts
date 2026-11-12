import { navAccountIdSet } from "../navCardMetrics";
import { resolveNavTreeLabel } from "../sidebarNavFromApi";
import type { GroupPageShell } from "../queries/groupPageShell";
import type { AccountListRow, DashboardAccountRow, NavTreeNodeDto } from "../types";

export type NavAccountLeaf = {
  node: NavTreeNodeDto;
  groupSlug: string;
  groupLabel: string;
};

/** All nav nodes with `account_id > 0` under `navNode`. */
export function collectNavAccountLeaves(navNode: NavTreeNodeDto): NavAccountLeaf[] {
  const out: NavAccountLeaf[] = [];
  const visit = (n: NavTreeNodeDto, groupSlug: string, _groupLabel: string) => {
    const slug = n.asset_group_slug ?? groupSlug;
    const label = resolveNavTreeLabel(n);
    if (n.account_id != null && n.account_id > 0) {
      out.push({ node: n, groupSlug: slug, groupLabel: label });
    }
    for (const c of n.children ?? []) {
      visit(c, slug, label);
    }
  };
  const rootSlug = navNode.asset_group_slug ?? navNode.slug;
  const rootLabel = resolveNavTreeLabel(navNode);
  visit(navNode, rootSlug, rootLabel);
  return out;
}

function categorySlugFromNav(node: NavTreeNodeDto): string {
  if (node.kind_slug?.trim()) return node.kind_slug.trim();
  if (node.asset_group_slug === "credit_cards") return "credit_card";
  if (node.asset_group_slug === "mortgage") return "mortgage";
  return "checking";
}

function accountListRowFromNavLeaf(leaf: NavAccountLeaf): AccountListRow {
  const { node, groupSlug, groupLabel } = leaf;
  const id = node.account_id!;
  return {
    id,
    name: resolveNavTreeLabel(node),
    notes: null,
    created_at: "1970-01-01T00:00:00.000Z",
    category_slug: categorySlugFromNav(node),
    category_label: categorySlugFromNav(node),
    group_slug: groupSlug,
    group_label: groupLabel,
    exclude_from_group_totals: node.exclude_from_parent_total ? 1 : undefined,
    color_rgb: node.color_rgb,
  };
}

function syntheticDashboardRow(leaf: NavAccountLeaf): DashboardAccountRow {
  const { node } = leaf;
  const accountId = node.account_id!;
  const category_slug = categorySlugFromNav(node);
  const name = resolveNavTreeLabel(node);

  return {
    account_id: accountId,
    name,
    group_slug: leaf.groupSlug,
    group_label: leaf.groupLabel,
    category_slug,
    category_label: category_slug,
    deposits: 0,
    delta_month: 0,
    delta_year: 0,
    deposits_month: 0,
    deposits_year: 0,
    prior_month_close: 0,
    prior_year_close: 0,
    current_value: 0,
    valuation_as_of: null,
    chart_inactive: node.chart_inactive,
    exclude_from_group_totals: node.exclude_from_parent_total ? 1 : undefined,
  };
}

export function buildGroupPageShellFromNav(navNode: NavTreeNodeDto): GroupPageShell {
  const leaves = collectNavAccountLeaves(navNode);
  const accounts = leaves.map(accountListRowFromNavLeaf);
  const dashAccounts = leaves.map((leaf) => syntheticDashboardRow(leaf));
  return { accounts, dashAccounts };
}

export function extractGroupPageShellFromReal(
  accounts: AccountListRow[],
  dashAccounts: DashboardAccountRow[],
  navNode: NavTreeNodeDto,
  firstMonth?: string | null
): GroupPageShell {
  const idSet = navAccountIdSet(navNode);
  return {
    accounts: accounts.filter((a) => idSet.has(a.id)),
    dashAccounts: dashAccounts.filter((a) => idSet.has(a.account_id)),
    ...(firstMonth ? { first_month: firstMonth } : {}),
  };
}
