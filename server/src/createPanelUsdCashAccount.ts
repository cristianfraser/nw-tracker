import { accountUsesUsdCashFlowKinds } from "./accountUsdCashFlows.js";
import { assetGroupBySlug, CASH_SAVINGS_BUCKET, ensureChildAssetGroupId } from "./assetGroupTree.js";
import { prettyRgbTripletForAccountId } from "./chartColorRgb.js";
import { clearAggregationCache } from "./aggregationCache.js";
import { db } from "./db.js";
import { buildPanelUsdCashAccountNotes } from "./panelAccountNotes.js";
import { validateMovementCreate } from "./movementUnitsPolicy.js";
import { seedNavTree } from "./seedNavTree.js";

export type PanelUsdCashAccountCreateBody = {
  account: {
    name: string;
    bucket_slug?: string;
    category_slug?: string;
    exclude_from_group_totals: boolean;
  };
  initial_movements?: {
    occurred_on: string;
    flow_kind: string;
    amount_clp: number | null;
    amount_usd: number | null;
    units_delta: number | null;
    counterpart_account_id?: number | null;
    counterpart_role?: "to" | "from";
  }[];
};

export type PanelUsdCashAccountCreateResult = {
  account_id: number;
  asset_group_id: number;
  movement_ids: number[];
  created_leaf_bucket: boolean;
};

const SLUG_RE = /^[a-z][a-z0-9_]*$/;
const PANEL_USD_CASH_BUCKET = "cash_savings";

function fail(status: number, error: string): never {
  const err = new Error(error) as Error & { status: number };
  err.status = status;
  throw err;
}

export function createPanelUsdCashAccount(
  body: PanelUsdCashAccountCreateBody
): PanelUsdCashAccountCreateResult {
  const acc = body.account;
  const name = acc.name?.trim() ?? "";
  const leafSlug = (acc.category_slug ?? "usd").trim().toLowerCase();
  const parentBucketSlug = (acc.bucket_slug ?? PANEL_USD_CASH_BUCKET).trim();

  if (!name) fail(400, "account.name is required");
  if (!leafSlug || !SLUG_RE.test(leafSlug)) {
    fail(400, "account.category_slug must be a lowercase slug (a-z, 0-9, _)");
  }
  if (parentBucketSlug !== PANEL_USD_CASH_BUCKET || !assetGroupBySlug(CASH_SAVINGS_BUCKET)) {
    fail(400, "panel USD cash accounts must use bucket cash_savings");
  }

  const notes = buildPanelUsdCashAccountNotes(leafSlug);
  const dup = db.prepare(`SELECT id FROM accounts WHERE notes = ?`).get(notes) as
    | { id: number }
    | undefined;
  if (dup) fail(409, `USD cash account already exists for key ${leafSlug} (id ${dup.id})`);

  const { id: assetGroupId, created: createdLeafBucket } = ensureChildAssetGroupId(
    CASH_SAVINGS_BUCKET,
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
  const insTransfer = db.prepare(
    `INSERT INTO movements (
       account_id, from_account_id, to_account_id, amount_clp, occurred_on, note,
       units_delta, flow_kind, amount_usd, ticker
     ) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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

    if (!accountMeta || !accountUsesUsdCashFlowKinds({ bucket_slug: accountMeta.bucket_slug, group_slug: parentBucketSlug, notes: accountMeta.notes })) {
      fail(400, "panel USD cash accounts must use import:panel|kind=usd notes");
    }

    for (let i = 0; i < movements.length; i++) {
      const m = movements[i]!;
      const payload: Record<string, unknown> = {
        occurred_on: m.occurred_on,
        flow_kind: m.flow_kind,
        amount_clp: m.amount_clp,
        amount_usd: m.amount_usd,
        units_delta: m.units_delta,
        counterpart_account_id: m.counterpart_account_id,
        counterpart_role: m.counterpart_role,
      };
      const validated = validateMovementCreate(
        {
          group_slug: parentBucketSlug,
          bucket_slug: accountMeta.bucket_slug,
          notes: accountMeta.notes,
        },
        payload,
        accountId
      );
      if (!validated.ok) {
        fail(validated.status, `initial_movements[${i}]: ${validated.error}`);
      }
      if (validated.mode === "transfer") {
        const r = insTransfer.run(
          validated.from_account_id,
          validated.to_account_id,
          validated.amount_clp,
          validated.occurred_on,
          validated.note,
          validated.units_delta,
          validated.flow_kind,
          validated.amount_usd,
          validated.ticker
        );
        movementIds.push(Number(r.lastInsertRowid));
      } else if (validated.mode === "brokerage") {
        const r = insBrokerage.run(
          accountId,
          validated.amount_clp,
          validated.occurred_on,
          validated.note,
          validated.units_delta,
          validated.flow_kind,
          validated.amount_usd,
          validated.ticker
        );
        movementIds.push(Number(r.lastInsertRowid));
      } else {
        fail(400, `initial_movements[${i}]: unsupported movement mode for USD cash account`);
      }
    }
  });
  tx();

  clearAggregationCache();
  seedNavTree();

  return {
    account_id: accountId,
    asset_group_id: assetGroupId,
    movement_ids: movementIds,
    created_leaf_bucket: createdLeafBucket,
  };
}
