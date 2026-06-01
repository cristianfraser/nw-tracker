import type { Database } from "better-sqlite3";
import { parseLegacyCheckingGastosPurchaseKey } from "./checkingGastosCategoryPersist.js";
import {
  CHECKING_INTERNAL_TRANSFER_CC_EXPENSE_SLUG,
  DEPOSITS_CC_EXPENSE_SLUG,
  getCcExpenseCategoryBySlug,
} from "./ccExpenseCategories.js";
import { db } from "./db.js";
import {
  cartolaDescriptionFromNote,
  loadDepositMatchCandidates,
  resolveAutoMatchCategorySlugForCheckingWithdrawal,
} from "./flowsCheckingGastos.js";

type CheckingPurchaseRow = {
  account_id: number;
  purchase_key: string;
  category_id: number | null;
};

type MovementRow = {
  id: number;
  account_id: number;
  occurred_on: string;
  amount_clp: number;
  note: string | null;
};

function movementFromLegacyPurchaseKey(
  accountId: number,
  purchaseKey: string,
  dbHandle: Database
): MovementRow | null {
  const parsed = parseLegacyCheckingGastosPurchaseKey(purchaseKey);
  if (!parsed) return null;
  return (
    dbHandle
      .prepare(
        `SELECT id, account_id, occurred_on, amount_clp, note
         FROM movements WHERE id = ? AND account_id = ?`
      )
      .get(parsed.movementId, accountId) as MovementRow | undefined
  ) ?? null;
}

function movementFromStablePurchaseKey(
  accountId: number,
  purchaseKey: string,
  dbHandle: Database
): MovementRow | null {
  const m =
    /^checking-cartola:(\d+):([^:]+):(\d{4}-\d{2}-\d{2}):(-?\d+):(\d+)(?::deposit)?$/.exec(
      purchaseKey
    );
  if (!m) return null;
  const keyAccountId = Number(m[1]);
  if (keyAccountId !== accountId) return null;
  const occurredOn = m[3]!;
  const amountClp = Number(m[4]);
  const idx = m[5]!;
  const noteNeedle = `|on:${occurredOn}|amt:${amountClp}|idx:${idx}`;
  return (
    dbHandle
      .prepare(
        `SELECT id, account_id, occurred_on, amount_clp, note
         FROM movements
         WHERE account_id = ?
           AND occurred_on = ?
           AND amount_clp = ?
           AND note LIKE 'import:cartola|%'
           AND note LIKE ?
         ORDER BY id DESC
         LIMIT 1`
      )
      .get(accountId, occurredOn, amountClp, `%${noteNeedle}%`) as MovementRow | undefined
  ) ?? null;
}

export function movementForCheckingPurchaseKey(
  accountId: number,
  purchaseKey: string,
  dbHandle: Database = db
): MovementRow | null {
  return (
    movementFromLegacyPurchaseKey(accountId, purchaseKey, dbHandle) ??
    movementFromStablePurchaseKey(accountId, purchaseKey, dbHandle)
  );
}

export function resolveAutoMatchCategoryIdForCheckingPurchase(
  accountId: number,
  purchaseKey: string,
  movement: MovementRow,
  depositCandidates = loadDepositMatchCandidates()
): number | null {
  const description = cartolaDescriptionFromNote(movement.note);
  const slug = resolveAutoMatchCategorySlugForCheckingWithdrawal(
    {
      occurred_on: movement.occurred_on,
      amount_clp: movement.amount_clp,
      description,
    },
    depositCandidates,
    accountId
  );
  if (slug == null) return null;
  return getCcExpenseCategoryBySlug(slug)?.id ?? null;
}

export function backfillCheckingAutoMatchCategories(dbHandle: Database = db): {
  scanned: number;
  updated: number;
  cleared: number;
  to_checking_internal: number;
  to_deposits: number;
} {
  const depositsCat = getCcExpenseCategoryBySlug(DEPOSITS_CC_EXPENSE_SLUG);
  const checkingInternalCat = getCcExpenseCategoryBySlug(
    CHECKING_INTERNAL_TRANSFER_CC_EXPENSE_SLUG
  );
  if (!depositsCat || !checkingInternalCat) {
    throw new Error("auto-match expense categories missing; run migrations first");
  }

  const rows = dbHandle
    .prepare(
      `SELECT account_id, purchase_key, category_id
       FROM cc_expense_unique_purchases
       WHERE purchase_key LIKE 'checking-%'
         AND (category_id IS NULL OR category_id IN (?, ?))`
    )
    .all(depositsCat.id, checkingInternalCat.id) as CheckingPurchaseRow[];

  const update = dbHandle.prepare(
    `UPDATE cc_expense_unique_purchases
     SET category_id = ?
     WHERE account_id = ? AND purchase_key = ?`
  );

  const depositCandidates = loadDepositMatchCandidates();
  let updated = 0;
  let cleared = 0;
  let toCheckingInternal = 0;
  let toDeposits = 0;

  const tx = dbHandle.transaction(() => {
    for (const row of rows) {
      const movement = movementForCheckingPurchaseKey(row.account_id, row.purchase_key, dbHandle);
      if (!movement) continue;

      const nextCategoryId = resolveAutoMatchCategoryIdForCheckingPurchase(
        row.account_id,
        row.purchase_key,
        movement,
        depositCandidates
      );

      if (nextCategoryId === row.category_id) continue;
      if (nextCategoryId == null && row.category_id == null) continue;

      update.run(nextCategoryId, row.account_id, row.purchase_key);
      updated += 1;
      if (nextCategoryId == null) cleared += 1;
      else if (nextCategoryId === checkingInternalCat.id) toCheckingInternal += 1;
      else if (nextCategoryId === depositsCat.id) toDeposits += 1;
    }
  });
  tx();

  return {
    scanned: rows.length,
    updated,
    cleared,
    to_checking_internal: toCheckingInternal,
    to_deposits: toDeposits,
  };
}
