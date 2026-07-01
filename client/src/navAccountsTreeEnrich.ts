import { collectNavAccountDataKeys } from "./portfolioNavFromApi";
import type { AccountListRow, NavTreeNodeDto } from "./types";

function leafBucketGroupSlug(account: AccountListRow): string {
  // Portfolio group slugs use single underscores (e.g. "cash_savings"); asset group slugs
  // use double underscores as level separators (e.g. "cash_eqs__cash_savings__usd").
  // When group_slug is a portfolio slug, use it directly so chart-inactive accounts that
  // are missing from the sidebar nav tree get inserted into the correct sub-bucket.
  if (account.group_slug && !account.group_slug.includes("__")) return account.group_slug;
  const slug = account.bucket_slug ?? account.group_slug;
  const idx = slug.indexOf("__");
  return idx >= 0 ? slug.slice(0, idx) : slug;
}

function accountNavLeafFromListRow(acc: AccountListRow): NavTreeNodeDto {
  return {
    node_id: `acc.${acc.id}`,
    slug: `account_${acc.id}`,
    label: acc.name,
    label_i18n_key: null,
    route_path: `/account/${acc.id}`,
    active_prefix: null,
    nav_end: true,
    show_leaf_hyphen: true,
    account_id: acc.id,
    source_account_id: acc.source_account_id ?? null,
    portfolio_group_id: null,
    expense_account_id: null,
    expense_account_slug: null,
    asset_group_slug: acc.bucket_slug ?? null,
    api_group: null,
    api_subgroup: null,
    color_rgb: acc.color_rgb ?? null,
    color: null,
    kind_slug: acc.category_slug ?? null,
    dashboard_bucket_slug: null,
    group_kind: "bucket",
    chart_inactive: acc.chart_inactive,
    children: [],
  };
}

/** Deepest portfolio group node matching the account leaf bucket (fallback: `root`). */
function findPlacementGroup(root: NavTreeNodeDto, account: AccountListRow): NavTreeNodeDto {
  const target = leafBucketGroupSlug(account);
  const bucket = account.bucket_slug ?? account.group_slug;
  let match: NavTreeNodeDto = root;
  let matchDepth = -1;

  const visit = (node: NavTreeNodeDto, depth: number) => {
    if (node.account_id != null) return;
    const slug = node.slug;
    const asset = node.asset_group_slug ?? "";
    const hit = slug === target || asset === target || slug === bucket || asset === bucket;
    if (hit && depth >= matchDepth) {
      match = node;
      matchDepth = depth;
    }
    for (const c of node.children ?? []) visit(c, depth + 1);
  };
  visit(root, 0);
  return match;
}

/**
 * Sidebar nav omits `chart_inactive` leaves; group-page “Cuentas en esta vista” should list
 * every portfolio-group member from `GET /api/accounts?portfolio_group=…`.
 */
export function enrichNavTreeWithAllAccounts(
  root: NavTreeNodeDto,
  accounts: readonly AccountListRow[]
): NavTreeNodeDto {
  const tree = structuredClone(root);
  const present = new Set(
    collectNavAccountDataKeys(tree)
      .map((k) => Number(k))
      .filter((n) => Number.isFinite(n))
  );

  const missing = accounts.filter((a) => !present.has(a.id));
  if (!missing.length) return tree;

  for (const acc of [...missing].sort((a, b) => a.id - b.id)) {
    const parent = findPlacementGroup(tree, acc);
    parent.children = [...parent.children, accountNavLeafFromListRow(acc)];
  }
  return tree;
}
