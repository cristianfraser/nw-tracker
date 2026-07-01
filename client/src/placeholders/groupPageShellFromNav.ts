import { navLeafAccountIdSet } from "../portfolioNavDashboardCards";
import { resolveNavTreeLabel } from "../sidebarNavFromApi";
import type { GroupPageShell } from "../queries/groupPageShell";
import type { DisplayUnit } from "../queries/keys";
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
    source_account_id: node.source_account_id,
  };
}

function syntheticDashboardRow(leaf: NavAccountLeaf, unit: DisplayUnit): DashboardAccountRow {
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
    deposits_clp: 0,
    deposits_usd: unit === "usd" ? 0 : null,
    delta_month_clp: 0,
    delta_month_usd: unit === "usd" ? 0 : null,
    delta_year_clp: 0,
    delta_year_usd: unit === "usd" ? 0 : null,
    deposits_month_clp: 0,
    deposits_month_usd: unit === "usd" ? 0 : null,
    deposits_year_clp: 0,
    deposits_year_usd: unit === "usd" ? 0 : null,
    prior_month_close_clp: 0,
    prior_month_close_usd: unit === "usd" ? 0 : null,
    prior_year_close_clp: 0,
    prior_year_close_usd: unit === "usd" ? 0 : null,
    current_value_clp: 0,
    valuation_as_of: null,
    current_value_usd: unit === "usd" ? 0 : null,
    chart_inactive: node.chart_inactive,
    exclude_from_group_totals: node.exclude_from_parent_total ? 1 : undefined,
  };
}

export function buildGroupPageShellFromNav(navNode: NavTreeNodeDto, unit: DisplayUnit): GroupPageShell {
  const leaves = collectNavAccountLeaves(navNode);
  const accounts = leaves.map(accountListRowFromNavLeaf);
  const dashAccounts = leaves.map((leaf) => syntheticDashboardRow(leaf, unit));
  return { accounts, dashAccounts };
}

export function extractGroupPageShellFromReal(
  accounts: AccountListRow[],
  dashAccounts: DashboardAccountRow[],
  navNode: NavTreeNodeDto
): GroupPageShell {
  const idSet = navLeafAccountIdSet(navNode);
  return {
    accounts: accounts.filter((a) => idSet.has(a.id)),
    dashAccounts: dashAccounts.filter((a) => idSet.has(a.account_id)),
  };
}
