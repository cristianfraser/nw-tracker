import { accountUsesBrokerageFlowKinds } from "./accountBrokerageFlows.js";
import { assetGroupBySlug, ensureChildAssetGroupId } from "./assetGroupTree.js";
import { prettyRgbTripletForAccountId } from "./chartColorRgb.js";
import { db } from "./db.js";
import { equityMarketKind } from "./equityQuote.js";
import { buildPanelAccountNotes } from "./panelAccountNotes.js";
import { validateMovementCreate } from "./movementUnitsPolicy.js";
import { seedNavTree } from "./seedNavTree.js";

export type PanelStockAccountCreateBody = {
  account: {
    name: string;
    /** Leaf bucket slug, e.g. `brokerage_acciones`. */
    bucket_slug?: string;
    /** @deprecated use bucket_slug */
    group_slug?: string;
    /** Leaf slug under bucket (defaults from ticker), e.g. `spy`. */
    category_slug?: string;
    ticker: string;
    price_source: "stocks_nyse" | "crypto_eod";
    exclude_from_group_totals: boolean;
  };
  initial_movements?: {
    occurred_on: string;
    flow_kind: string;
    amount_clp: number | null;
    amount_usd: number | null;
    units_delta: number | null;
  }[];
};

export type PanelStockAccountCreateResult = {
  account_id: number;
  asset_group_id: number;
  movement_ids: number[];
  created_leaf_bucket: boolean;
};

const SLUG_RE = /^[a-z][a-z0-9_]*$/;
const PANEL_STOCK_BUCKETS = new Set(["brokerage_acciones", "brokerage_crypto"]);

function fail(status: number, error: string): never {
  const err = new Error(error) as Error & { status: number };
  err.status = status;
  throw err;
}

export function createPanelStockAccount(
  body: PanelStockAccountCreateBody
): PanelStockAccountCreateResult {
  const acc = body.account;
  const name = acc.name?.trim() ?? "";
  const leafSlug = (acc.category_slug ?? "").trim().toLowerCase();
  const parentBucketSlug = (acc.bucket_slug ?? acc.group_slug ?? "").trim();
  const ticker = (acc.ticker ?? "").trim().toUpperCase();

  if (!name) fail(400, "account.name is required");
  if (!leafSlug || !SLUG_RE.test(leafSlug)) {
    fail(400, "account.category_slug (leaf slug) must be a lowercase slug (a-z, 0-9, _)");
  }
  if (!parentBucketSlug) fail(400, "account.bucket_slug is required");
  if (!PANEL_STOCK_BUCKETS.has(parentBucketSlug) || !assetGroupBySlug(parentBucketSlug)) {
    fail(400, "panel stock accounts must use bucket brokerage_acciones or brokerage_crypto");
  }
  if (!ticker || !/^[A-Z0-9.-]+$/.test(ticker)) fail(400, "account.ticker is invalid");

  if (acc.price_source === "crypto_eod") {
    if (!["BTC-USD", "ETH-USD"].includes(ticker)) {
      fail(400, "crypto_eod price_source only supports BTC-USD and ETH-USD tickers");
    }
    if (parentBucketSlug !== "brokerage_crypto") {
      fail(400, "crypto_eod accounts must use bucket_slug brokerage_crypto");
    }
  } else if (equityMarketKind(ticker) === "crypto24") {
    fail(400, "stocks_nyse price_source does not support crypto tickers");
  } else if (parentBucketSlug !== "brokerage_acciones") {
    fail(400, "stocks_nyse accounts must use bucket_slug brokerage_acciones");
  }

  const notes = buildPanelAccountNotes(ticker, leafSlug);
  const dup = db.prepare(`SELECT id FROM accounts WHERE notes = ?`).get(notes) as
    | { id: number }
    | undefined;
  if (dup) fail(409, `account already exists for ticker ${ticker} (id ${dup.id})`);

  const { id: assetGroupId, created: createdLeafBucket } = ensureChildAssetGroupId(
    parentBucketSlug,
    leafSlug,
    name
  );

  const movementIds: number[] = [];
  const movements = body.initial_movements ?? [];
  let accountId = 0;

  const insBrokerage = db.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta, flow_kind, amount_usd, ticker)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insStandard = db.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
     VALUES (?, ?, ?, ?, ?)`
  );

  const tx = db.transaction(() => {
    const exclude = acc.exclude_from_group_totals ? 1 : 0;
    const insAcc = db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, exclude_from_group_totals)
         VALUES (?, ?, ?, ?)`
      )
      .run(assetGroupId, name, notes, exclude);
    accountId = Number(insAcc.lastInsertRowid);
    db.prepare(`UPDATE accounts SET color_rgb = ? WHERE id = ?`).run(
      prettyRgbTripletForAccountId(accountId),
      accountId
    );

    const accountMeta = db
      .prepare(
        `SELECT g.slug AS bucket_slug, a.notes AS notes
         FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE a.id = ?`
      )
      .get(accountId) as { bucket_slug: string; notes: string | null };

    if (
      !accountMeta ||
      !accountUsesBrokerageFlowKinds(
        { group_slug: parentBucketSlug, bucket_slug: accountMeta.bucket_slug },
        accountMeta.notes
      )
    ) {
      fail(400, "panel stock accounts must be brokerage accounts with import:panel notes");
    }

    for (let i = 0; i < movements.length; i++) {
      const m = movements[i]!;
      const payload: Record<string, unknown> = {
        occurred_on: m.occurred_on,
        flow_kind: m.flow_kind,
        amount_clp: m.amount_clp,
        amount_usd: m.amount_usd,
        units_delta: m.units_delta,
        ticker,
      };
      const validated = validateMovementCreate(
        { group_slug: parentBucketSlug, bucket_slug: accountMeta.bucket_slug },
        payload
      );
      if (!validated.ok) {
        fail(validated.status, `initial_movements[${i}]: ${validated.error}`);
      }
      if (validated.mode === "brokerage") {
        const r = insBrokerage.run(
          accountId,
          validated.amount_clp,
          validated.occurred_on,
          validated.note,
          validated.units_delta,
          validated.flow_kind,
          validated.amount_usd,
          validated.ticker ?? ticker
        );
        movementIds.push(Number(r.lastInsertRowid));
      } else {
        const r = insStandard.run(
          accountId,
          validated.amount_clp,
          validated.occurred_on,
          validated.note,
          validated.units_delta
        );
        movementIds.push(Number(r.lastInsertRowid));
      }
    }
  });
  tx();

  seedNavTree();

  return {
    account_id: accountId,
    asset_group_id: assetGroupId,
    movement_ids: movementIds,
    created_leaf_bucket: createdLeafBucket,
  };
}
