import { accountChartInactive } from "./accountChartInactive.js";
import { getAccountColorRgb, resolvePortfolioGroupColorRgb, rgbTripletToCss } from "./chartColorRgb.js";
import { db } from "./db.js";
import { getLiabilitiesNavChildren } from "./liabilityTree.js";
import { isUsdCashAccount } from "./usdCashAccounts.js";

export type NavTreeBuildOptions = {
  /** Panel / admin views: keep accounts with long zero valuation tails in the tree. */
  includeChartInactiveAccounts?: boolean;
};

export type NavTreeNodeDto = {
  node_id: string;
  slug: string;
  label: string;
  label_i18n_key: string | null;
  route_path: string;
  active_prefix: string | null;
  nav_end: boolean;
  show_leaf_hyphen: boolean;
  account_id: number | null;
  /** Operational account when `account_id` is a liability snapshot row. */
  source_account_id: number | null;
  portfolio_group_id: number | null;
  expense_account_id: number | null;
  expense_account_slug: string | null;
  asset_group_slug: string | null;
  api_group: string | null;
  api_subgroup: string | null;
  color_rgb: string | null;
  color: string | null;
  kind_slug: string | null;
  dashboard_bucket_slug: string | null;
  exclude_from_parent_total: boolean;
  /** `nav_bucket` = sidebar grouping only (e.g. inversiones, efectivo); `liability_group` = Pasivos root. */
  group_kind: "bucket" | "reference" | "nav_bucket" | "liability_group";
  /**
   * Inactive accounts (long zero tail) are omitted from the tree; group buckets whose children are
   * all inactive are kept but marked — the sidebar hides them, group pages keep them for period cards.
   */
  chart_inactive?: boolean;
  children: NavTreeNodeDto[];
};

type GroupRow = {
  id: number;
  parent_id: number | null;
  slug: string;
  label: string;
  sort_order: number;
  color_rgb: string | null;
  route_path: string | null;
  active_prefix: string | null;
  nav_end: number;
  show_leaf_hyphen: number;
  label_i18n_key: string | null;
  api_group: string | null;
  api_subgroup: string | null;
  asset_group_slug: string | null;
  sidebar_section: string;
  group_kind: string;
  kind_slug: string | null;
  dashboard_bucket_slug: string | null;
  exclude_from_parent_total: number;
};

type ItemRow = {
  group_id: number;
  item_kind: "group" | "account" | "expense_account";
  child_group_id: number | null;
  account_id: number | null;
  expense_account_id: number | null;
  sort_order: number;
};

function loadGroups(): GroupRow[] {
  return db
    .prepare(
      `SELECT id, parent_id, slug, label, sort_order, color_rgb, route_path, active_prefix,
              nav_end, show_leaf_hyphen, label_i18n_key, api_group, api_subgroup, asset_group_slug, sidebar_section,
              group_kind, kind_slug, dashboard_bucket_slug, exclude_from_parent_total
       FROM portfolio_groups
       ORDER BY sort_order, id`
    )
    .all() as GroupRow[];
}

function loadItems(): ItemRow[] {
  return db
    .prepare(
      `SELECT group_id, item_kind, child_group_id, account_id, expense_account_id, sort_order
       FROM portfolio_group_items
       ORDER BY sort_order, id`
    )
    .all() as ItemRow[];
}

/**
 * Bucket inactivity for sidebar hiding: account/expense children are active; a group child is
 * active unless itself marked. Asset buckets (`kind_slug`) with no active children are inactive —
 * covers both "all accounts chart-inactive" and "no accounts linked". `nav_bucket` hubs collapse
 * only when they have children and all are inactive (empty hubs stay routable links); reference
 * and liability groups are never marked.
 */
export function navGroupChartInactive(
  groupKind: NavTreeNodeDto["group_kind"],
  kindSlug: string | null,
  children: readonly NavTreeNodeDto[]
): boolean {
  const allInactive = children.every((c) => c.chart_inactive === true);
  if (groupKind === "bucket" && kindSlug != null) return allInactive;
  if (groupKind === "nav_bucket") return children.length > 0 && allInactive;
  return false;
}

/** Drop portfolio group nodes that have no account/expense leaves after inactive filtering. */
function pruneEmptyNavGroups(nodes: NavTreeNodeDto[]): NavTreeNodeDto[] {
  return nodes
    .map((n) => ({ ...n, children: pruneEmptyNavGroups(n.children) }))
    .filter(
      (n) =>
        n.account_id != null ||
        n.expense_account_id != null ||
        n.children.length > 0 ||
        (n.portfolio_group_id != null && Boolean(n.route_path?.trim()))
    );
}

function buildNode(
  group: GroupRow,
  itemsByGroup: Map<number, ItemRow[]>,
  groupsById: Map<number, GroupRow>,
  accountMeta: Map<number, { name: string; color_rgb: string }>,
  expenseMeta: Map<number, { label: string; slug: string }>,
  options: NavTreeBuildOptions = {}
): NavTreeNodeDto {
  const items = itemsByGroup.get(group.id) ?? [];
  const children: NavTreeNodeDto[] = [];

  for (const item of items) {
    if (item.item_kind === "group" && item.child_group_id != null) {
      const child = groupsById.get(item.child_group_id);
      if (child) {
        children.push(buildNode(child, itemsByGroup, groupsById, accountMeta, expenseMeta, options));
      }
    } else if (item.item_kind === "account" && item.account_id != null) {
      if (
        !options.includeChartInactiveAccounts &&
        accountChartInactive(item.account_id) &&
        !isUsdCashAccount(item.account_id)
      ) {
        continue;
      }
      const meta = accountMeta.get(item.account_id);
      const color_rgb = meta?.color_rgb ?? getAccountColorRgb(item.account_id);
      children.push({
        node_id: `acc.${item.account_id}`,
        slug: `account_${item.account_id}`,
        label: meta?.name ?? `Account ${item.account_id}`,
        label_i18n_key: null,
        route_path: `/account/${item.account_id}`,
        active_prefix: null,
        nav_end: true,
        show_leaf_hyphen: true,
        account_id: item.account_id,
        portfolio_group_id: null,
        source_account_id: null,
        expense_account_id: null,
        expense_account_slug: null,
        asset_group_slug: null,
        api_group: null,
        api_subgroup: null,
        group_kind: "bucket",
        kind_slug: null,
        dashboard_bucket_slug: null,
        exclude_from_parent_total: false,
        color_rgb,
        color: rgbTripletToCss(color_rgb),
        children: [],
      });
    } else if (item.item_kind === "expense_account" && item.expense_account_id != null) {
      const meta = expenseMeta.get(item.expense_account_id);
      const slug = meta?.slug ?? String(item.expense_account_id);
      children.push({
        node_id: `exp.${slug}`,
        slug: `expense_${slug}`,
        label: meta?.label ?? slug,
        label_i18n_key: `expenses.accounts.${slug}`,
        route_path: `/flows/expenses/real_estate/${slug}`,
        active_prefix: null,
        nav_end: true,
        show_leaf_hyphen: true,
        account_id: null,
        portfolio_group_id: null,
        source_account_id: null,
        expense_account_id: item.expense_account_id,
        expense_account_slug: slug,
        asset_group_slug: null,
        api_group: null,
        api_subgroup: null,
        group_kind: "bucket",
        kind_slug: null,
        dashboard_bucket_slug: null,
        exclude_from_parent_total: false,
        color_rgb: null,
        color: null,
        children: [],
      });
    }
  }

  const groupKind =
    group.group_kind === "reference" ||
    group.group_kind === "nav_bucket" ||
    group.group_kind === "nav_hub" ||
    group.group_kind === "liability_group"
      ? group.group_kind === "nav_hub"
        ? "nav_bucket"
        : group.group_kind
      : "bucket";

  /** Explicit `portfolio_groups.color_rgb` wins; otherwise same resolver as charts (largest child balance). */
  const resolved = group.color_rgb ?? resolvePortfolioGroupColorRgb(group.id);

  const prunedChildren = pruneEmptyNavGroups(children);
  const chartInactive = navGroupChartInactive(groupKind, group.kind_slug, prunedChildren);

  return {
    node_id: group.slug,
    slug: group.slug,
    label: group.label,
    label_i18n_key: group.label_i18n_key,
    route_path: group.route_path ?? "/",
    active_prefix: group.active_prefix,
    nav_end: group.nav_end === 1,
    show_leaf_hyphen: group.show_leaf_hyphen === 1,
    account_id: null,
    portfolio_group_id: group.id,
    source_account_id: null,
    expense_account_id: null,
    expense_account_slug: null,
    asset_group_slug: group.asset_group_slug,
    api_group: group.api_group,
    api_subgroup: group.api_subgroup,
    kind_slug: group.kind_slug,
    dashboard_bucket_slug: group.dashboard_bucket_slug,
    exclude_from_parent_total: group.exclude_from_parent_total === 1,
    color_rgb: resolved,
    color: rgbTripletToCss(resolved),
    group_kind: groupKind,
    ...(chartInactive ? { chart_inactive: true } : {}),
    children: prunedChildren,
  };
}

function loadMetaMaps(items: ItemRow[]) {
  const accountIds = new Set<number>();
  const expenseIds = new Set<number>();
  for (const item of items) {
    if (item.account_id != null) accountIds.add(item.account_id);
    if (item.expense_account_id != null) expenseIds.add(item.expense_account_id);
  }

  const accountMeta = new Map<number, { name: string; color_rgb: string }>();
  if (accountIds.size > 0) {
    const ph = [...accountIds].map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT id, name, color_rgb FROM accounts WHERE id IN (${ph})`)
      .all(...accountIds) as { id: number; name: string; color_rgb: string | null }[];
    for (const r of rows) {
      accountMeta.set(r.id, {
        name: r.name,
        color_rgb: r.color_rgb ?? getAccountColorRgb(r.id),
      });
    }
  }

  const expenseMeta = new Map<number, { label: string; slug: string }>();
  if (expenseIds.size > 0) {
    const ph = [...expenseIds].map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT id, label, slug FROM expense_accounts WHERE id IN (${ph})`)
      .all(...expenseIds) as { id: number; label: string; slug: string }[];
    for (const r of rows) expenseMeta.set(r.id, { label: r.label, slug: r.slug });
  }

  return { accountMeta, expenseMeta };
}

function buildNavForest(section: string | null): NavTreeNodeDto[] {
  const groups = loadGroups();
  const items = loadItems();
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const itemsByGroup = new Map<number, ItemRow[]>();
  for (const item of items) {
    const arr = itemsByGroup.get(item.group_id) ?? [];
    arr.push(item);
    itemsByGroup.set(item.group_id, arr);
  }
  const { accountMeta, expenseMeta } = loadMetaMaps(items);

  const roots = groups.filter((g) => {
    if (g.parent_id != null) return false;
    if (section == null) return true;
    return g.sidebar_section === section;
  });

  return roots.map((g) => buildNode(g, itemsByGroup, groupsById, accountMeta, expenseMeta));
}

/** `portfolio_groups.slug = net_worth` — home page + dashboard hierarchy (first-level bucket groups as children). */
export function getNetWorthNavGroupNode(
  options: NavTreeBuildOptions = {}
): NavTreeNodeDto | null {
  const groups = loadGroups();
  const nw = groups.find((g) => g.slug === "net_worth");
  if (!nw) return null;
  const items = loadItems();
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const itemsByGroup = new Map<number, ItemRow[]>();
  for (const item of items) {
    const arr = itemsByGroup.get(item.group_id) ?? [];
    arr.push(item);
    itemsByGroup.set(item.group_id, arr);
  }
  const { accountMeta, expenseMeta } = loadMetaMaps(items);
  return buildNode(nw, itemsByGroup, groupsById, accountMeta, expenseMeta, options);
}

/** Full sidebar layout: dashboard, main asset branches, flows, search, rates. */
export function getSidebarNavPayload(): {
  dashboard: NavTreeNodeDto | null;
  net_worth: NavTreeNodeDto | null;
  main: NavTreeNodeDto[];
  flows: NavTreeNodeDto | null;
  search: NavTreeNodeDto | null;
  projections: NavTreeNodeDto | null;
  rates: NavTreeNodeDto | null;
} {
  const linkRoots = buildNavForest("link");
  const mainRoots = buildNavForest("main").map((node) =>
    node.slug === "liabilities" ? { ...node, children: getLiabilitiesNavChildren() } : node
  );
  const flowRoots = buildNavForest("flows");

  return {
    dashboard: linkRoots.find((n) => n.slug === "dashboard") ?? null,
    net_worth: getNetWorthNavGroupNode(),
    main: mainRoots,
    flows: flowRoots.find((n) => n.slug === "flows") ?? flowRoots[0] ?? null,
    search: linkRoots.find((n) => n.slug === "search") ?? null,
    projections: linkRoots.find((n) => n.slug === "projections") ?? null,
    rates: linkRoots.find((n) => n.slug === "rates") ?? null,
  };
}

/** Inversiones portfolio subtree only (chart grouping). */
export function getPortfolioTreeForCharts(): NavTreeNodeDto[] {
  const groups = loadGroups();
  const inv = groups.find((g) => g.slug === "inversiones");
  if (!inv) return [];
  const items = loadItems();
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const itemsByGroup = new Map<number, ItemRow[]>();
  for (const item of items) {
    const arr = itemsByGroup.get(item.group_id) ?? [];
    arr.push(item);
    itemsByGroup.set(item.group_id, arr);
  }
  const { accountMeta, expenseMeta } = loadMetaMaps(items);
  return [buildNode(inv, itemsByGroup, groupsById, accountMeta, expenseMeta)];
}
