/**
 * One loaded nav tree with its roles as data (docs/untangle-plan.md F4).
 *
 * `portfolio_groups` + `portfolio_group_items`, with the Pasivos subtree (`liability_groups` +
 * `liability_group_items`) attached at load: a portfolio node whose slug names a liability group
 * holds that group's accounts. Loaded once per database state (`dbStateMemo`: a write drops it).
 *
 * The roles are columns (migration 272): `nw_bucket` (the buckets net worth sums), `investment_root`
 * (the roots of «Inversiones» and the Rentabilidad pages), `nets_linked_group_id` (the group whose
 * owed total this group's value nets), `property_overlay` and the reference groups'
 * `chart_host_slug`. Nothing here parses a slug or names one: every answer is a walk over the data.
 *
 * Reads no valuation and no clock — a leaf the payload builders and the chart plan depend on.
 */
import { db } from "./db.js";
import { dbStateMemo } from "./dbStateMemo.js";

export type NavGroup = Readonly<{
  id: number;
  slug: string;
  label: string;
  parentId: number | null;
  groupKind: string;
  kindSlug: string | null;
  assetGroupSlug: string | null;
  dashboardBucketSlug: string | null;
  dashboardSortOrder: number | null;
  routePath: string | null;
  excludeFromParentTotal: boolean;
  nwBucket: boolean;
  investmentRoot: boolean;
  netsLinkedGroupId: number | null;
  propertyOverlay: boolean;
  /** A reference group's host page (the page whose chart draws it). */
  chartHostSlug: string | null;
  /** Child groups (`item_kind = 'group'`), in item order. */
  childGroupIds: readonly number[];
  /** Direct accounts, in item order: portfolio items, or the attached liability group's items. */
  accountIds: readonly number[];
  /** A reference group's weighted sources (`item_kind = 'linked_group'`), in item order. */
  linkedGroups: readonly { groupId: number; weight: number }[];
  /** True when the accounts come from the attached liability group. */
  liabilityBacked: boolean;
  /** The attached liability group's kind (`credit_card`, `mortgage`), or null. */
  liabilityKind: string | null;
}>;

export type NavTreeModel = Readonly<{
  byId: ReadonlyMap<number, NavGroup>;
  bySlug: ReadonlyMap<string, NavGroup>;
  /** The portfolio group each account is an item of (an account sits in at most one). */
  groupOfAccount: ReadonlyMap<number, number>;
}>;

type GroupRow = {
  id: number;
  slug: string;
  label: string;
  parent_id: number | null;
  group_kind: string;
  kind_slug: string | null;
  asset_group_slug: string | null;
  dashboard_bucket_slug: string | null;
  dashboard_sort_order: number | null;
  route_path: string | null;
  exclude_from_parent_total: number;
  nw_bucket: number;
  investment_root: number;
  nets_linked_group_id: number | null;
  property_overlay: number;
  chart_host_slug: string | null;
};

type ItemRow = {
  group_id: number;
  item_kind: string;
  child_group_id: number | null;
  account_id: number | null;
  link_weight: number | null;
};

function loadNavTreeModel(): NavTreeModel {
  const groups = db
    .prepare(
      `SELECT id, slug, label, parent_id, group_kind, kind_slug, asset_group_slug, dashboard_bucket_slug,
              dashboard_sort_order, route_path, exclude_from_parent_total, nw_bucket, investment_root,
              nets_linked_group_id, property_overlay, chart_host_slug
       FROM portfolio_groups ORDER BY sort_order, id`
    )
    .all() as GroupRow[];
  const items = db
    .prepare(
      `SELECT group_id, item_kind, child_group_id, account_id, link_weight
       FROM portfolio_group_items ORDER BY sort_order, id`
    )
    .all() as ItemRow[];
  // The Pasivos subtree: a card master stays a member whatever it shows, but a non-card liability
  // excluded from group totals is not on the Pasivos pages (the tab's long-standing rule).
  const liabilityItems = db
    .prepare(
      `SELECT lg.slug, i.account_id, a.exclude_from_group_totals, a.import_key
       FROM liability_group_items i
       JOIN liability_groups lg ON lg.id = i.group_id
       JOIN accounts a ON a.id = i.account_id
       WHERE i.item_kind = 'account'
       ORDER BY lg.id, i.sort_order, i.id`
    )
    .all() as {
    slug: string;
    account_id: number;
    exclude_from_group_totals: number;
    import_key: string | null;
  }[];
  const liabilityAccountsBySlug = new Map<string, number[]>();
  const liabilityKindBySlug = new Map<string, string | null>(
    (db.prepare(`SELECT slug, liability_kind FROM liability_groups`).all() as { slug: string; liability_kind: string | null }[]).map(
      (r) => [r.slug, r.liability_kind]
    )
  );
  for (const r of liabilityItems) {
    const isCard = (r.import_key ?? "").startsWith("credit_card_master|");
    if (!isCard && r.exclude_from_group_totals === 1) continue;
    const arr = liabilityAccountsBySlug.get(r.slug) ?? [];
    arr.push(r.account_id);
    liabilityAccountsBySlug.set(r.slug, arr);
  }

  const itemsByGroup = new Map<number, ItemRow[]>();
  for (const it of items) {
    const arr = itemsByGroup.get(it.group_id) ?? [];
    arr.push(it);
    itemsByGroup.set(it.group_id, arr);
  }

  const byId = new Map<number, NavGroup>();
  const bySlug = new Map<string, NavGroup>();
  const groupOfAccount = new Map<number, number>();
  for (const g of groups) {
    const own = itemsByGroup.get(g.id) ?? [];
    const portfolioAccounts = own.filter((i) => i.item_kind === "account" && i.account_id != null).map((i) => i.account_id!);
    for (const id of portfolioAccounts) {
      const prior = groupOfAccount.get(id);
      if (prior != null && prior !== g.id) {
        throw new Error(`nav tree: account ${id} is an item of two groups (${prior}, ${g.id})`);
      }
      groupOfAccount.set(id, g.id);
    }
    const liability = liabilityKindBySlug.has(g.slug) ? (liabilityAccountsBySlug.get(g.slug) ?? []) : undefined;
    const node: NavGroup = {
      id: g.id,
      slug: g.slug,
      label: g.label,
      parentId: g.parent_id,
      groupKind: g.group_kind,
      kindSlug: g.kind_slug,
      assetGroupSlug: g.asset_group_slug,
      dashboardBucketSlug: g.dashboard_bucket_slug,
      dashboardSortOrder: g.dashboard_sort_order,
      routePath: g.route_path,
      excludeFromParentTotal: g.exclude_from_parent_total === 1,
      nwBucket: g.nw_bucket === 1,
      investmentRoot: g.investment_root === 1,
      netsLinkedGroupId: g.nets_linked_group_id,
      propertyOverlay: g.property_overlay === 1,
      chartHostSlug: g.chart_host_slug,
      childGroupIds: own.filter((i) => i.item_kind === "group" && i.child_group_id != null).map((i) => i.child_group_id!),
      accountIds: liability != null && portfolioAccounts.length === 0 ? liability : portfolioAccounts,
      linkedGroups: own
        .filter((i) => i.item_kind === "linked_group" && i.child_group_id != null)
        .map((i) => ({ groupId: i.child_group_id!, weight: Number(i.link_weight) })),
      liabilityBacked: liability != null && portfolioAccounts.length === 0,
      liabilityKind: liability != null && portfolioAccounts.length === 0 ? (liabilityKindBySlug.get(g.slug) ?? null) : null,
    };
    byId.set(g.id, node);
    bySlug.set(g.slug, node);
  }
  return { byId, bySlug, groupOfAccount };
}

/** The tree as the database holds it now. */
export function navTreeModel(): NavTreeModel {
  return dbStateMemo("nav_tree_model", 0, loadNavTreeModel);
}

export function navGroup(slug: string): NavGroup | null {
  return navTreeModel().bySlug.get(slug) ?? null;
}

export function navGroupById(id: number): NavGroup | null {
  return navTreeModel().byId.get(id) ?? null;
}

export function requireNavGroup(slug: string): NavGroup {
  const g = navGroup(slug);
  if (!g) throw new Error(`nav tree: no group «${slug}»`);
  return g;
}

/** The node and its ancestors, nearest first. */
export function navGroupAncestry(groupId: number): NavGroup[] {
  const out: NavGroup[] = [];
  const seen = new Set<number>();
  let cur = navGroupById(groupId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur);
    cur = cur.parentId != null ? navGroupById(cur.parentId) : null;
  }
  return out;
}

/** The net-worth buckets, in their dashboard order (net worth = Σ of these). */
export function nwBuckets(): readonly NavGroup[] {
  return dbStateMemo("nav_tree_nw_buckets", 0, () =>
    [...navTreeModel().byId.values()]
      .filter((g) => g.nwBucket)
      .sort((a, b) => (a.dashboardSortOrder ?? 0) - (b.dashboardSortOrder ?? 0) || a.id - b.id)
  );
}

export function nwBucketSlugs(): readonly string[] {
  return nwBuckets().map((g) => g.slug);
}

export function isNwBucketSlug(slug: string): boolean {
  return navGroup(slug)?.nwBucket === true;
}

/** The roots of «Inversiones» (retirement, brokerage), in their dashboard order. */
export function investmentRoots(): readonly NavGroup[] {
  return nwBuckets().filter((g) => g.investmentRoot);
}

export function investmentRootSlugs(): readonly string[] {
  return investmentRoots().map((g) => g.slug);
}

/** The net-worth bucket a group sits in (itself included), or null outside them. */
export function nwBucketOfGroup(groupId: number): string | null {
  return navGroupAncestry(groupId).find((g) => g.nwBucket)?.slug ?? null;
}

/** The portfolio group an account is an item of, or null. */
export function leafGroupOfAccount(accountId: number): NavGroup | null {
  const id = navTreeModel().groupOfAccount.get(accountId);
  return id != null ? navGroupById(id) : null;
}

/** The net-worth bucket an account sits in, or null (liabilities, accounts outside the tree). */
export function bucketOfAccount(accountId: number): string | null {
  const leaf = leafGroupOfAccount(accountId);
  return leaf ? nwBucketOfGroup(leaf.id) : null;
}

/**
 * Account ids in a group's subtree, ascending. `forTotals` skips child groups marked
 * `exclude_from_parent_total` (their accounts do not roll up into this group's total).
 */
export function groupAccountIds(slugOrId: string | number, opts: { forTotals?: boolean } = {}): number[] {
  const root = typeof slugOrId === "number" ? navGroupById(slugOrId) : navGroup(slugOrId);
  if (!root) return [];
  const out = new Set<number>();
  const seen = new Set<number>();
  const visit = (g: NavGroup) => {
    if (seen.has(g.id)) return;
    seen.add(g.id);
    for (const id of g.accountIds) out.add(id);
    for (const childId of g.childGroupIds) {
      const child = navGroupById(childId);
      if (!child) continue;
      if (opts.forTotals && child.excludeFromParentTotal) continue;
      visit(child);
    }
  };
  visit(root);
  return [...out].sort((a, b) => a - b);
}

/**
 * True for a group inside an investment root (the root included), and for a hub whose child groups
 * are all investment groups («Inversiones»).
 */
export function isInvestmentGroup(slug: string): boolean {
  const g = navGroup(slug);
  if (!g) return false;
  if (navGroupAncestry(g.id).some((a) => a.investmentRoot)) return true;
  const children = g.childGroupIds.map((id) => navGroupById(id)).filter((c): c is NavGroup => c != null);
  return children.length > 0 && children.every((c) => isInvestmentGroup(c.slug));
}

/** True when an account sits in an investment root's subtree. */
export function isInvestmentAccount(accountId: number): boolean {
  const leaf = leafGroupOfAccount(accountId);
  return leaf != null && navGroupAncestry(leaf.id).some((g) => g.investmentRoot);
}

/** The group whose owed total this group's value nets (the cash bucket nets the linked cards), or null. */
export function netsLinkedGroup(slug: string): NavGroup | null {
  const g = navGroup(slug);
  return g?.netsLinkedGroupId != null ? navGroupById(g.netsLinkedGroupId) : null;
}

/** The reference groups a host page draws (`chart_host_slug`), in their order. */
export function referenceGroupsOfHost(hostSlug: string): NavGroup[] {
  return [...navTreeModel().byId.values()].filter((g) => g.groupKind === "reference" && g.chartHostSlug === hostSlug);
}

/**
 * The host whose reference overlays a group's valuation chart draws: the group itself when it
 * hosts any, else the nearest hosting ancestor whose netting it shares (the cash savings page
 * draws the cash bucket's credit-card line: both net the same cards). Null otherwise.
 */
export function chartHostOfGroup(slug: string): string | null {
  const g = navGroup(slug);
  if (!g) return null;
  if (referenceGroupsOfHost(g.slug).length > 0) return g.slug;
  if (g.netsLinkedGroupId == null) return null;
  for (const a of navGroupAncestry(g.id).slice(1)) {
    if (a.netsLinkedGroupId === g.netsLinkedGroupId && referenceGroupsOfHost(a.slug).length > 0) return a.slug;
  }
  return null;
}

/** True when a group's chart carries the property's «hipoteca»/«valor» overlay lines. */
export function groupHasPropertyOverlay(slug: string): boolean {
  return navGroup(slug)?.propertyOverlay === true;
}

/**
 * The one group other groups net (the linked credit cards): every `nets_linked_group_id` points at
 * it. Throws when none or several are declared — the linked total is one sum.
 */
export function nettedGroup(): NavGroup {
  const ids = new Set([...navTreeModel().byId.values()].map((g) => g.netsLinkedGroupId).filter((id): id is number => id != null));
  if (ids.size !== 1) throw new Error(`nav tree: expected one netted group, found ${ids.size}`);
  const g = navGroupById([...ids][0]!);
  if (!g) throw new Error("nav tree: the netted group does not exist");
  return g;
}

/** The Pasivos groups (portfolio nodes backed by a liability group), in tree order. */
export function liabilityGroups(): NavGroup[] {
  return [...navTreeModel().byId.values()].filter((g) => g.liabilityBacked);
}

/** True for a hub whose child groups are all investment roots («Inversiones»): its total is Σ of them. */
export function isInvestmentRootsHub(slug: string): boolean {
  const g = navGroup(slug);
  if (!g || g.childGroupIds.length === 0) return false;
  return g.childGroupIds.every((id) => navGroupById(id)?.investmentRoot === true);
}
