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
  const pg = portfolioGroupBySlug(bucketSlug);
  if (!pg) fail(400, `unknown bucket ${bucketSlug}`);
  if (pg.group_kind === "liability_group") {
    fail(400, "cannot create accounts under a liability bucket");
  }
  const parentAssetSlug = (pg.asset_group_slug ?? "").trim() || bucketSlug;
  if (!assetGroupBySlug(parentAssetSlug)) {
    fail(400, `bucket ${bucketSlug} has no backing asset group`);
  }

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

  const dup = db.prepare(`SELECT id FROM accounts WHERE notes = ?`).get(notes) as
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
        `INSERT INTO accounts (asset_group_id, name, notes, exclude_from_group_totals, equity_ticker)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(assetGroupId, name, notes, exclude, ticker);
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
