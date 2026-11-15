/**
 * Where an account sits in the net-worth tree (docs/untangle-plan.md F4, wave 8b).
 *
 * An account sits on a leaf asset group; the bucket that holds it is the portfolio group backed by
 * the nearest asset group above that leaf. The code that creates, moves or renames an account
 * writes that one membership with {@link placeAccount}, inside its own transaction — the boot seed
 * (`seedNavTree.ts`) creates the tree's reference rows and never places an account.
 *
 * The buckets that hold accounts are the seeded ones named here plus the data-defined ones: a
 * `bucket` group backed by its own asset group and filed under Brokerage or under another bucket
 * (a managed portfolio unit, migrations 190 and 192). Hubs (Brokerage, Retirement, APV, cash)
 * hold groups only, so an account on a leaf straight under one has no bucket and is refused.
 *
 * Some buckets are part of the tree only while they hold something (a class bucket of Brokerage,
 * a managed unit, a US retirement leaf, and US itself): placement links such a bucket to its
 * parent when it gets its first item and unlinks it when it loses its last one. The others are
 * linked by the seed.
 *
 * Database reads and writes only: `navTreeModel.ts` asks {@link accountsMissingPlacement} when it
 * loads the tree, so nothing here may read the tree model.
 */
import { db } from "./db.js";

/** The seeded buckets that hold accounts and are always in the tree (the seed links them). */
const ALWAYS_LINKED_ACCOUNT_BUCKETS: readonly string[] = [
  "cash_savings",
  "checking_accounts",
  "real_estate",
  "retirement_afp_afc",
  "retirement_apv_a",
  "retirement_apv_b",
];

/** Brokerage's class buckets, with their place among Brokerage's children. */
const BROKERAGE_CLASS_BUCKET_SORT: Readonly<Record<string, number>> = {
  brokerage_mutual_funds: 0,
  brokerage_long_term: 5,
  brokerage_acciones: 10,
  brokerage_opciones: 15,
  brokerage_crypto: 20,
};

/** The US retirement leaves (created by the country split): each holds the accounts on its own asset group. */
const RETIREMENT_US_LEAF_BUCKETS: readonly string[] = ["retirement_us_401k", "retirement_us_roth_ira", "retirement_us_hsa"];

/** Groups that hold no account themselves and are in the tree only while a child of theirs is. */
const HUBS_LINKED_WHILE_HOLDING: readonly string[] = ["retirement_us"];

/** The hub the data-defined buckets are filed under. */
const DATA_BUCKET_ROOT = "brokerage";

type GroupRow = {
  id: number;
  slug: string;
  label: string;
  parent_id: number | null;
  group_kind: string;
  asset_group_slug: string | null;
  sort_order: number;
};

type AssetRow = { id: number; slug: string; parent_id: number | null };

type Bucket = { group: GroupRow; assetGroupId: number };

type PlacementTree = {
  groupById: Map<number, GroupRow>;
  assetById: Map<number, AssetRow>;
  /** Asset groups that have sub-groups (accounts sit on leaves). */
  assetIdsWithChildren: Set<number>;
  bucketByGroupId: Map<number, Bucket>;
  bucketByAssetGroupId: Map<number, Bucket>;
  /** Groups linked to their parent only while they hold an item. */
  linkedWhileHolding: Set<number>;
};

function loadPlacementTree(): PlacementTree {
  const groups = db
    .prepare(`SELECT id, slug, label, parent_id, group_kind, asset_group_slug, sort_order FROM portfolio_groups ORDER BY id`)
    .all() as GroupRow[];
  const assets = db.prepare(`SELECT id, slug, parent_id FROM asset_groups`).all() as AssetRow[];
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const groupBySlug = new Map(groups.map((g) => [g.slug, g]));
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const assetBySlug = new Map(assets.map((a) => [a.slug, a]));
  const assetIdsWithChildren = new Set(assets.filter((a) => a.parent_id != null).map((a) => a.parent_id!));

  const bucketByGroupId = new Map<number, Bucket>();
  const bucketByAssetGroupId = new Map<number, Bucket>();
  const linkedWhileHolding = new Set<number>();
  const addBucket = (group: GroupRow, asset: AssetRow, whileHolding: boolean): void => {
    const other = bucketByAssetGroupId.get(asset.id);
    if (other) {
      throw new Error(`account placement: buckets ${other.group.slug} and ${group.slug} are both backed by asset group ${asset.slug}`);
    }
    const bucket = { group, assetGroupId: asset.id };
    bucketByGroupId.set(group.id, bucket);
    bucketByAssetGroupId.set(asset.id, bucket);
    if (whileHolding) linkedWhileHolding.add(group.id);
  };

  const seeded: [slug: string, whileHolding: boolean][] = [
    ...ALWAYS_LINKED_ACCOUNT_BUCKETS.map((slug): [string, boolean] => [slug, false]),
    ...Object.keys(BROKERAGE_CLASS_BUCKET_SORT).map((slug): [string, boolean] => [slug, true]),
    ...RETIREMENT_US_LEAF_BUCKETS.map((slug): [string, boolean] => [slug, true]),
  ];
  for (const [slug, whileHolding] of seeded) {
    const group = groupBySlug.get(slug);
    if (!group) continue;
    // A seeded bucket with no asset group of its own (Long-term on a database that never had one) holds nothing.
    const asset = assetBySlug.get(group.asset_group_slug ?? group.slug);
    if (asset) addBucket(group, asset, whileHolding);
  }
  for (const slug of HUBS_LINKED_WHILE_HOLDING) {
    const hub = groupBySlug.get(slug);
    if (hub) linkedWhileHolding.add(hub.id);
  }

  // Data-defined buckets: filed under Brokerage or under a bucket found so far, each backed by its own asset group.
  const root = groupBySlug.get(DATA_BUCKET_ROOT);
  let found = true;
  while (found) {
    found = false;
    for (const g of groups) {
      if (bucketByGroupId.has(g.id) || g.group_kind !== "bucket" || g.asset_group_slug == null || g.parent_id == null) continue;
      const parentBucket = bucketByGroupId.get(g.parent_id);
      if (g.parent_id !== root?.id && !parentBucket) continue;
      const asset = assetBySlug.get(g.asset_group_slug);
      if (!asset) throw new Error(`account placement: bucket ${g.slug} is backed by asset group ${g.asset_group_slug}, which does not exist`);
      if (parentBucket && !assetIsStrictlyInside(assetById, asset.id, parentBucket.assetGroupId)) {
        throw new Error(
          `account placement: bucket ${g.slug} under ${parentBucket.group.slug} is backed by asset group ` +
            `${g.asset_group_slug}, which is not nested inside ${assetById.get(parentBucket.assetGroupId)!.slug}`
        );
      }
      addBucket(g, asset, true);
      found = true;
    }
  }
  return { groupById, assetById, assetIdsWithChildren, bucketByGroupId, bucketByAssetGroupId, linkedWhileHolding };
}

function assetIsStrictlyInside(assetById: Map<number, AssetRow>, assetId: number, ancestorId: number): boolean {
  let cur = assetById.get(assetId)?.parent_id ?? null;
  const seen = new Set<number>();
  while (cur != null && !seen.has(cur)) {
    if (cur === ancestorId) return true;
    seen.add(cur);
    cur = assetById.get(cur)?.parent_id ?? null;
  }
  return false;
}

/** The bucket backed by the nearest asset group at or above `assetGroupId`, or null when none is. */
function bucketOfAssetGroup(tree: PlacementTree, assetGroupId: number): Bucket | null {
  let cur: number | null = assetGroupId;
  const seen = new Set<number>();
  while (cur != null && !seen.has(cur)) {
    const bucket = tree.bucketByAssetGroupId.get(cur);
    if (bucket) return bucket;
    seen.add(cur);
    cur = tree.assetById.get(cur)?.parent_id ?? null;
  }
  return null;
}

const accountRowStmt = db.prepare(`SELECT id, asset_group_id, primary_portfolio_group_id FROM accounts WHERE id = ?`);
const accountItemsStmt = db.prepare(
  `SELECT id, group_id FROM portfolio_group_items WHERE item_kind = 'account' AND account_id = ? ORDER BY id`
);
const deleteItemStmt = db.prepare(`DELETE FROM portfolio_group_items WHERE id = ?`);
const insertAccountItemStmt = db.prepare(
  `INSERT INTO portfolio_group_items (group_id, item_kind, account_id, sort_order) VALUES (?, 'account', ?, 0)`
);
const insertGroupItemStmt = db.prepare(
  `INSERT INTO portfolio_group_items (group_id, item_kind, child_group_id, sort_order) VALUES (?, 'group', ?, ?)`
);
const groupEdgeStmt = db.prepare(
  `SELECT id FROM portfolio_group_items WHERE item_kind = 'group' AND group_id = ? AND child_group_id = ?`
);
const deleteGroupEdgesStmt = db.prepare(`DELETE FROM portfolio_group_items WHERE item_kind = 'group' AND child_group_id = ?`);
const heldItemCountStmt = db.prepare(
  `SELECT COUNT(*) AS c FROM portfolio_group_items WHERE group_id = ? AND item_kind IN ('account', 'group')`
);
const heldItemsStmt = db.prepare(
  `SELECT i.id, i.item_kind, i.sort_order, COALESCE(a.name, g.label) AS name
   FROM portfolio_group_items i
   LEFT JOIN accounts a ON a.id = i.account_id
   LEFT JOIN portfolio_groups g ON g.id = i.child_group_id
   WHERE i.group_id = ? AND i.item_kind IN ('account', 'group')`
);
const setItemSortStmt = db.prepare(`UPDATE portfolio_group_items SET sort_order = ? WHERE id = ?`);
const setPrimaryGroupStmt = db.prepare(`UPDATE accounts SET primary_portfolio_group_id = ? WHERE id = ?`);

/** A bucket lists what it holds — accounts and sub-buckets together — by name, ten apart. */
function orderBucketItems(tree: PlacementTree, groupId: number): void {
  if (!tree.bucketByGroupId.has(groupId)) return;
  const rows = heldItemsStmt.all(groupId) as { id: number; item_kind: string; sort_order: number; name: string }[];
  rows.sort(
    (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      (a.item_kind === b.item_kind ? 0 : a.item_kind === "group" ? -1 : 1) ||
      a.id - b.id
  );
  rows.forEach((r, i) => {
    if (r.sort_order !== i * 10) setItemSortStmt.run(i * 10, r.id);
  });
}

function parentOf(tree: PlacementTree, group: GroupRow): GroupRow {
  const parent = group.parent_id != null ? tree.groupById.get(group.parent_id) : undefined;
  if (!parent) throw new Error(`account placement: group ${group.slug} has no parent to be linked under`);
  return parent;
}

/** Links `group` to its parent (and that parent upward) when it is part of the tree only while it holds something. */
function linkWhileHolding(tree: PlacementTree, group: GroupRow): void {
  let cur = group;
  while (tree.linkedWhileHolding.has(cur.id)) {
    const parent = parentOf(tree, cur);
    if (groupEdgeStmt.get(parent.id, cur.id) == null) {
      insertGroupItemStmt.run(parent.id, cur.id, BROKERAGE_CLASS_BUCKET_SORT[cur.slug] ?? cur.sort_order);
      orderBucketItems(tree, parent.id);
    }
    cur = parent;
  }
}

/** Unlinks `group` from the tree (and its parent upward) when it holds nothing and is only there while it does. */
function unlinkWhenEmpty(tree: PlacementTree, group: GroupRow): void {
  let cur = group;
  while (tree.linkedWhileHolding.has(cur.id)) {
    if ((heldItemCountStmt.get(cur.id) as { c: number }).c > 0) return;
    deleteGroupEdgesStmt.run(cur.id);
    const parent = parentOf(tree, cur);
    orderBucketItems(tree, parent.id);
    cur = parent;
  }
}

function requireBucketOfAccount(tree: PlacementTree, account: { id: number; asset_group_id: number }): Bucket {
  const asset = tree.assetById.get(account.asset_group_id);
  if (!asset) throw new Error(`account placement: account ${account.id} sits on asset group ${account.asset_group_id}, which does not exist`);
  if (tree.assetIdsWithChildren.has(asset.id)) {
    throw new Error(`account placement: account ${account.id} sits on asset group ${asset.slug}, which has sub-groups (an account sits on a leaf)`);
  }
  const bucket = bucketOfAssetGroup(tree, asset.id);
  if (!bucket) {
    throw new Error(`account placement: account ${account.id} sits on asset group ${asset.slug}, which no bucket of the net-worth tree holds`);
  }
  return bucket;
}

function placeAccountIn(tree: PlacementTree, accountId: number): void {
  const account = accountRowStmt.get(accountId) as
    | { id: number; asset_group_id: number; primary_portfolio_group_id: number | null }
    | undefined;
  if (!account) throw new Error(`account placement: account ${accountId} does not exist`);
  const bucket = requireBucketOfAccount(tree, account);
  const targetId = bucket.group.id;

  const stored = accountItemsStmt.all(accountId) as { id: number; group_id: number }[];
  const left: number[] = [];
  for (const row of stored) {
    if (row.group_id === targetId) continue;
    deleteItemStmt.run(row.id);
    left.push(row.group_id);
  }
  if (!stored.some((r) => r.group_id === targetId)) insertAccountItemStmt.run(targetId, accountId);
  if (account.primary_portfolio_group_id !== targetId) setPrimaryGroupStmt.run(targetId, accountId);
  orderBucketItems(tree, targetId);
  linkWhileHolding(tree, bucket.group);

  for (const groupId of left) {
    const group = tree.groupById.get(groupId);
    if (!group) continue;
    orderBucketItems(tree, groupId);
    unlinkWhenEmpty(tree, group);
  }
}

/**
 * Writes one account's place in the net-worth tree: its membership of the bucket that holds its
 * asset group (leaving any other group it was an item of), its position among the bucket's items,
 * `accounts.primary_portfolio_group_id`, and the link of a bucket that is in the tree only while
 * it holds something. Call it in the transaction that creates the account, moves it to another
 * asset group or renames it. Throws when no bucket holds the account's asset group (a liability,
 * a leaf straight under a hub): such an account has no place in this tree.
 */
export function placeAccount(accountId: number): void {
  db.transaction(() => placeAccountIn(loadPlacementTree(), accountId))();
}

/** The bucket that holds an account by its asset group, or null when none does (a card, a loan). */
export function accountBucketSlug(accountId: number): string | null {
  const account = accountRowStmt.get(accountId) as { asset_group_id: number } | undefined;
  if (!account) return null;
  return bucketOfAssetGroup(loadPlacementTree(), account.asset_group_id)?.group.slug ?? null;
}

/**
 * Takes an account out of the tree (before it is deleted): its membership goes, and a bucket that
 * is in the tree only while it holds something is unlinked when this was its last item.
 */
export function removeAccountPlacement(accountId: number): void {
  db.transaction(() => {
    const tree = loadPlacementTree();
    const stored = accountItemsStmt.all(accountId) as { id: number; group_id: number }[];
    for (const row of stored) deleteItemStmt.run(row.id);
    setPrimaryGroupStmt.run(null, accountId);
    for (const row of stored) {
      const group = tree.groupById.get(row.group_id);
      if (!group) continue;
      orderBucketItems(tree, row.group_id);
      unlinkWhenEmpty(tree, group);
    }
  })();
}

/**
 * Places every account a bucket holds, for code that builds a tree from nothing (the demo
 * generator, the country split, a fixture seed): accounts written before their buckets existed.
 * An account no bucket holds (a card, a loan) is left to its own tree. Returns how many it placed.
 */
export function placeAllAccounts(): number {
  return db.transaction(() => {
    const tree = loadPlacementTree();
    const accounts = db.prepare(`SELECT id, asset_group_id FROM accounts ORDER BY id`).all() as { id: number; asset_group_id: number }[];
    let placed = 0;
    for (const a of accounts) {
      if (bucketOfAssetGroup(tree, a.asset_group_id) == null) continue;
      placeAccountIn(tree, a.id);
      placed += 1;
    }
    return placed;
  })();
}

export type MissingPlacement = { accountId: number; assetGroupSlug: string; bucketSlug: string; storedGroupSlug: string | null };

/**
 * The accounts a bucket holds by their asset group but whose stored membership says otherwise (no
 * item, or an item of another group). Empty on a consistent database: every writer places the
 * account it creates or moves.
 */
export function accountsMissingPlacement(): MissingPlacement[] {
  const tree = loadPlacementTree();
  const rows = db
    .prepare(
      `SELECT a.id, a.asset_group_id, i.group_id
       FROM accounts a
       LEFT JOIN portfolio_group_items i ON i.account_id = a.id AND i.item_kind = 'account'
       ORDER BY a.id`
    )
    .all() as { id: number; asset_group_id: number; group_id: number | null }[];
  const out: MissingPlacement[] = [];
  for (const r of rows) {
    const bucket = bucketOfAssetGroup(tree, r.asset_group_id);
    if (!bucket || bucket.group.id === r.group_id) continue;
    out.push({
      accountId: r.id,
      assetGroupSlug: tree.assetById.get(r.asset_group_id)?.slug ?? String(r.asset_group_id),
      bucketSlug: bucket.group.slug,
      storedGroupSlug: r.group_id != null ? (tree.groupById.get(r.group_id)?.slug ?? String(r.group_id)) : null,
    });
  }
  return out;
}

/** Throws when an account a bucket holds is not stored as its item (see {@link accountsMissingPlacement}). */
export function assertAccountsPlaced(): void {
  const missing = accountsMissingPlacement();
  if (missing.length === 0) return;
  throw new Error(
    "net-worth tree: accounts not placed in the bucket that holds their asset group (placeAccount writes it): " +
      missing
        .map((m) => `account ${m.accountId} on ${m.assetGroupSlug} belongs in ${m.bucketSlug}, stored in ${m.storedGroupSlug ?? "no group"}`)
        .join("; ")
  );
}
