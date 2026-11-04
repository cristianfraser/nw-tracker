import { collectNavAccountDataKeys } from "./portfolioNavFromApi";
import type { AccountListRow, NavTreeNodeDto } from "./types";

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

/** The deepest group of the tree whose server-stated members (`member_account_ids`) name the account. */
function deepestGroupClaiming(root: NavTreeNodeDto, accountId: number): NavTreeNodeDto | null {
  let match: NavTreeNodeDto | null = null;
  let matchDepth = -1;
  const visit = (node: NavTreeNodeDto, depth: number) => {
    if (node.account_id != null) return;
    if (node.member_account_ids?.includes(accountId) && depth > matchDepth) {
      match = node;
      matchDepth = depth;
    }
    for (const c of node.children ?? []) visit(c, depth + 1);
  };
  visit(root, 0);
  return match;
}

/**
 * The sidebar nav leaves out accounts that hold nothing today and retired cards; a page's accounts
 * tree («Cuentas en esta vista») lists every account of `GET /api/accounts?portfolio_group=…`. Each
 * missing one goes under the deepest group whose `member_account_ids` — the server's membership,
 * hidden accounts included — names it. An account no group names is a mismatch between the two
 * server answers, and throws.
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
    const parent = deepestGroupClaiming(tree, acc.id);
    if (!parent) {
      throw new Error(
        `Account ${acc.id} (${acc.name}) is listed for «${root.slug}» but no group of its nav tree has it as a member`
      );
    }
    parent.children = [...parent.children, accountNavLeafFromListRow(acc)];
  }
  return tree;
}
