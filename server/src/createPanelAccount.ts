import { accountBucketKindSlug } from "./accountBucket.js";
import { accountUsesBrokerageFlowKinds } from "./accountBrokerageFlows.js";
import { accountUsesUsdCashFlowKinds } from "./accountUsdCashFlows.js";
import { assetGroupBySlug, ensureChildAssetGroupId } from "./assetGroupTree.js";
import { isClpCashKindSlug } from "./clpCashAccounts.js";
import { clearAggregationCache } from "./aggregationCache.js";
import { db } from "./db.js";
import { equityMarketKind } from "./equityQuote.js";
import { buildPanelAccountNotes, buildPanelCashAccountNotes } from "./panelAccountNotes.js";
import { portfolioGroupBySlug } from "./portfolioGroupTree.js";
import { prettyRgbTripletForAccountId } from "./chartColorRgb.js";
import { reseedAccountSyncSources } from "./accountSyncSources.js";
import { seedNavTree } from "./seedNavTree.js";

/**
 * Unified Panel → Accounts create. The account's *behavior* is carried by its leaf category
 * kind (`accountBucketKindSlug`) plus `equity_ticker`; the home **bucket** is a free choice of
 * any non-liability leaf bucket. Accounts are created empty — flows are added afterwards via the
 * per-account movement forms (which do auto-mirror parity), so there are no `initial_movements`.
 */
export type PanelAccountType = "equity" | "crypto" | "clp_cash" | "usd_cash";

export type PanelAccountCreateBody = {
  account: {
    account_type: PanelAccountType;
    name: string;
    /** Leaf bucket slug from the nav tree, e.g. `brokerage_acciones`, `cash_savings`, `real_estate`. */
    bucket_slug: string;
    /** Leaf category key under the bucket (defaults from ticker or name). */
    category_slug?: string;
    /** Required for equity/crypto. */
    ticker?: string;
    exclude_from_group_totals: boolean;
  };
};

export type PanelAccountCreateResult = {
  account_id: number;
  asset_group_id: number;
  created_leaf_bucket: boolean;
  ticker: string | null;
};

const SLUG_RE = /^[a-z][a-z0-9_]*$/;
const PANEL_ACCOUNT_TYPES = new Set<PanelAccountType>([
  "equity",
  "crypto",
  "clp_cash",
  "usd_cash",
]);

function fail(status: number, error: string): never {
  const err = new Error(error) as Error & { status: number };
  err.status = status;
  throw err;
}

/** Bucket (portfolio nav leaf) → backing asset-group parent slug; throws 400 on liability/unknown. */
function resolveBucketParentAssetSlug(bucketSlug: string, verb: "create" | "move"): string {
  const pg = portfolioGroupBySlug(bucketSlug);
  if (!pg) fail(400, `unknown bucket ${bucketSlug}`);
  if (pg.group_kind === "liability_group") {
    fail(400, `cannot ${verb} accounts under a liability bucket`);
  }
  const parentAssetSlug = (pg.asset_group_slug ?? "").trim() || bucketSlug;
  if (!assetGroupBySlug(parentAssetSlug)) {
    fail(400, `bucket ${bucketSlug} has no backing asset group`);
  }
  return parentAssetSlug;
}

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function createPanelAccount(body: PanelAccountCreateBody): PanelAccountCreateResult {
  const acc = body.account;
  const type = acc.account_type;
  const name = acc.name?.trim() ?? "";

  if (!PANEL_ACCOUNT_TYPES.has(type)) fail(400, `unsupported account_type ${type}`);
  if (!name) fail(400, "account.name is required");

  // Resolve the chosen bucket (portfolio nav slug) to its asset-group parent.
  const bucketSlug = (acc.bucket_slug ?? "").trim();
  if (!bucketSlug) fail(400, "account.bucket_slug is required");
  const parentAssetSlug = resolveBucketParentAssetSlug(bucketSlug, "create");

  const isEquity = type === "equity" || type === "crypto";

  let ticker: string | null = null;
  let childSlug: string;
  let notes: string;

  if (isEquity) {
    ticker = (acc.ticker ?? "").trim().toUpperCase();
    if (!ticker || !/^[A-Z0-9.-]+$/.test(ticker)) fail(400, "account.ticker is invalid");
    if (type === "crypto") {
      if (!["BTC-USD", "ETH-USD"].includes(ticker)) {
        fail(400, "crypto accounts only support BTC-USD or ETH-USD tickers");
      }
    } else if (equityMarketKind(ticker) === "crypto24") {
      fail(400, "equity accounts do not support crypto tickers (use account_type crypto)");
    }
    const categoryKey = (acc.category_slug?.trim() || slugify(ticker)).toLowerCase();
    if (!SLUG_RE.test(categoryKey)) {
      fail(400, "account.category_slug must be a lowercase slug (a-z, 0-9, _)");
    }
    childSlug = categoryKey;
    notes = buildPanelAccountNotes(ticker, categoryKey);
  } else {
    const kind = type === "clp_cash" ? "clp" : "usd";
    const categoryKey = (acc.category_slug?.trim() || slugify(name)).toLowerCase();
    if (!SLUG_RE.test(categoryKey)) {
      fail(400, "account.category_slug must be a lowercase slug (a-z, 0-9, _)");
    }
    // Leaf slug ends in the kind so `accountBucketKindSlug` resolves the cash behavior regardless
    // of which bucket the account is filed under (e.g. `<bucket>__savings__clp` → kind `clp`).
    childSlug = `${categoryKey}__${kind}`;
    notes = buildPanelCashAccountNotes(kind, categoryKey);
  }

  const dup = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(notes) as
    | { id: number }
    | undefined;
  if (dup) fail(409, `account already exists for ${notes} (id ${dup.id})`);

  const { id: assetGroupId, created: createdLeafBucket } = ensureChildAssetGroupId(
    parentAssetSlug,
    childSlug,
    name
  );

  let accountId = 0;
  const tx = db.transaction(() => {
    const exclude = acc.exclude_from_group_totals ? 1 : 0;
    const insAcc = db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key, exclude_from_group_totals, equity_ticker)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(assetGroupId, name, notes, notes, exclude, ticker);
    accountId = Number(insAcc.lastInsertRowid);
    db.prepare(`UPDATE accounts SET color_rgb = ? WHERE id = ?`).run(
      prettyRgbTripletForAccountId(accountId),
      accountId
    );

    const meta = db
      .prepare(
        `SELECT g.slug AS bucket_slug, a.notes AS notes, a.equity_ticker AS equity_ticker
         FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE a.id = ?`
      )
      .get(accountId) as {
      bucket_slug: string;
      notes: string | null;
      equity_ticker: string | null;
    };

    // Fail fast: the account must actually dispatch to the intended behavior (no inert accounts).
    const accountRow = {
      group_slug: parentAssetSlug,
      bucket_slug: meta.bucket_slug,
      notes: meta.notes,
      equity_ticker: meta.equity_ticker,
    };
    if (isEquity) {
      if (!accountUsesBrokerageFlowKinds(accountRow)) {
        fail(500, "created equity account does not resolve to brokerage flow kinds");
      }
    } else if (type === "usd_cash") {
      if (!accountUsesUsdCashFlowKinds(accountRow)) {
        fail(500, "created USD cash account does not resolve to USD cash flow kinds");
      }
    } else if (!isClpCashKindSlug(accountBucketKindSlug(meta.bucket_slug))) {
      fail(500, "created CLP cash account does not resolve to the CLP cash ledger");
    }
  });
  tx();

  clearAggregationCache();
  seedNavTree();
  reseedAccountSyncSources(accountId);

  return {
    account_id: accountId,
    asset_group_id: assetGroupId,
    created_leaf_bucket: createdLeafBucket,
    ticker,
  };
}

export type PanelAccountUpdateBody = {
  name?: unknown;
  bucket_slug?: unknown;
};

export type PanelAccountUpdateResult = {
  account_id: number;
  name: string;
  asset_group_id: number;
  /** Leaf `asset_groups.slug` after the update. */
  bucket_slug: string;
  created_leaf_bucket: boolean;
};

const assetGroupByIdStmt = db.prepare(
  `SELECT id, slug, parent_id FROM asset_groups WHERE id = ?`
);

/**
 * Category key the leaf bucket was created with: leaf slug minus the nearest ancestor-slug
 * prefix (handles reparented sub-buckets, e.g. `cash_eqs__cuenta_corriente` under
 * `cash_eqs__checking_accounts` → `cuenta_corriente`). Falls back to the full leaf slug.
 */
function leafCategoryKey(leafSlug: string, leafParentId: number | null): string {
  let parentId = leafParentId;
  while (parentId != null) {
    const parent = assetGroupByIdStmt.get(parentId) as
      | { id: number; slug: string; parent_id: number | null }
      | undefined;
    if (!parent) break;
    if (leafSlug.startsWith(`${parent.slug}__`)) return leafSlug.slice(parent.slug.length + 2);
    parentId = parent.parent_id;
  }
  return leafSlug;
}

/**
 * Panel → Accounts edit: rename and/or move to another non-liability leaf bucket. A move
 * re-files the account on a leaf under the new bucket's asset group (same category key, so
 * `accountBucketKindSlug` behavior is preserved — enforced, not assumed) and reseeds the nav tree.
 */
export function updatePanelAccount(
  accountId: number,
  body: PanelAccountUpdateBody
): PanelAccountUpdateResult {
  const acc = db
    .prepare(
      `SELECT a.id, a.name, a.account_kind, a.asset_group_id,
              g.slug AS leaf_slug, g.parent_id AS leaf_parent_id
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id = ?`
    )
    .get(accountId) as
    | {
        id: number;
        name: string;
        account_kind: string;
        asset_group_id: number;
        leaf_slug: string;
        leaf_parent_id: number | null;
      }
    | undefined;
  if (!acc) fail(404, "account not found");
  if (acc.account_kind === "liability_view") {
    fail(400, "liability-view accounts are edited via their master account");
  }

  const hasName = body.name !== undefined;
  const hasBucket = body.bucket_slug !== undefined;
  if (!hasName && !hasBucket) fail(400, "nothing to update: pass name and/or bucket_slug");

  let name = acc.name;
  if (hasName) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      fail(400, "name must be a non-empty string");
    }
    name = body.name.trim();
  }

  let assetGroupId = acc.asset_group_id;
  let leafSlug = acc.leaf_slug;
  let createdLeafBucket = false;
  let movedBucket = false;

  if (hasBucket) {
    if (typeof body.bucket_slug !== "string" || !body.bucket_slug.trim()) {
      fail(400, "bucket_slug must be a non-empty string");
    }
    const bucketSlug = body.bucket_slug.trim();
    const parentAssetSlug = resolveBucketParentAssetSlug(bucketSlug, "move");

    const currentKind = accountBucketKindSlug(acc.leaf_slug);
    if (currentKind === "credit_card") {
      fail(400, "credit-card accounts cannot move between buckets");
    }

    const categoryKey = leafCategoryKey(acc.leaf_slug, acc.leaf_parent_id);
    const newLeafSlug =
      parentAssetSlug === categoryKey ? categoryKey : `${parentAssetSlug}__${categoryKey}`;
    if (newLeafSlug !== acc.leaf_slug) {
      // Fail fast: the move must not change the account's behavior kind (afp, clp, ticker, …).
      const newKind = accountBucketKindSlug(newLeafSlug);
      if (newKind !== currentKind) {
        fail(400, `moving to ${bucketSlug} would change the account kind (${currentKind} → ${newKind})`);
      }
      const ensured = ensureChildAssetGroupId(parentAssetSlug, categoryKey, name);
      assetGroupId = ensured.id;
      createdLeafBucket = ensured.created;
      leafSlug = newLeafSlug;
      movedBucket = true;
    }
  }

  db.prepare(`UPDATE accounts SET name = ?, asset_group_id = ? WHERE id = ?`).run(
    name,
    assetGroupId,
    accountId
  );

  clearAggregationCache();
  if (movedBucket) seedNavTree();

  return {
    account_id: accountId,
    name,
    asset_group_id: assetGroupId,
    bucket_slug: leafSlug,
    created_leaf_bucket: createdLeafBucket,
  };
}
