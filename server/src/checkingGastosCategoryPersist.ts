import type { Database } from "better-sqlite3";
import DatabaseConstructor from "better-sqlite3";
import { checkingCartolaStablePurchaseKey } from "./checkingCartolaParse.js";
import { db } from "./db.js";

export function legacyCheckingGastosPurchaseKey(
  movementId: number,
  portion: "gastos" | "deposit" = "gastos"
): string {
  return portion === "gastos" ? `checking-mv:${movementId}` : `checking-mv:${movementId}:deposit`;
}

export function parseLegacyCheckingGastosPurchaseKey(
  purchaseKey: string
): { movementId: number; portion: "gastos" | "deposit" } | null {
  const deposit = purchaseKey.endsWith(":deposit");
  const raw = deposit ? purchaseKey.slice(0, -":deposit".length) : purchaseKey;
  const m = /^checking-mv:(\d+)$/.exec(raw);
  if (!m) return null;
  const movementId = Number(m[1]);
  if (!Number.isFinite(movementId)) return null;
  return { movementId, portion: deposit ? "deposit" : "gastos" };
}

function upsertUniquePurchaseCategory(
  accountId: number,
  purchaseKey: string,
  categoryId: number | null,
  dbHandle: Database
): void {
  dbHandle
    .prepare(
      `INSERT INTO cc_expense_unique_purchases (account_id, purchase_key, category_id)
       VALUES (?, ?, ?)
       ON CONFLICT(account_id, purchase_key) DO UPDATE SET
         category_id = COALESCE(excluded.category_id, cc_expense_unique_purchases.category_id)`
    )
    .run(accountId, purchaseKey, categoryId);
}

function migratePurchaseNotesKey(
  accountId: number,
  legacyKey: string,
  stableKey: string,
  dbHandle: Database
): void {
  const row = dbHandle
    .prepare(
      `SELECT notes FROM cc_expense_purchase_notes
       WHERE account_id = ? AND purchase_key = ?`
    )
    .get(accountId, legacyKey) as { notes: string } | undefined;
  if (!row?.notes?.trim()) return;
  dbHandle
    .prepare(
      `INSERT INTO cc_expense_purchase_notes (account_id, purchase_key, notes, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(account_id, purchase_key) DO UPDATE SET
         notes = excluded.notes,
         updated_at = excluded.updated_at`
    )
    .run(accountId, stableKey, row.notes);
}

/** Copy Único category from legacy `checking-mv:{id}` to stable cartola note key. */
export function migrateCheckingGastosCategoryToStableKey(
  accountId: number,
  movementId: number,
  note: string | null | undefined,
  dbHandle: Database = db
): number {
  let migrated = 0;
  for (const portion of ["gastos", "deposit"] as const) {
    const legacyKey = legacyCheckingGastosPurchaseKey(movementId, portion);
    const stableKey = checkingCartolaStablePurchaseKey(accountId, note, portion);
    if (!stableKey || stableKey === legacyKey) continue;
    const row = dbHandle
      .prepare(
        `SELECT category_id FROM cc_expense_unique_purchases
         WHERE account_id = ? AND purchase_key = ?`
      )
      .get(accountId, legacyKey) as { category_id: number | null } | undefined;
    if (!row) continue;
    upsertUniquePurchaseCategory(accountId, stableKey, row.category_id, dbHandle);
    migratePurchaseNotesKey(accountId, legacyKey, stableKey, dbHandle);
    migrated += 1;
  }
  return migrated;
}

/** Before deleting cartola movements, persist Único categories on stable keys. */
export function preserveCheckingGastosCategoriesForCartolaNotes(
  accountId: number,
  notePrefix: string,
  dbHandle: Database = db
): number {
  const rows = dbHandle
    .prepare(
      `SELECT id, note FROM movements
       WHERE account_id = ? AND note LIKE ?`
    )
    .all(accountId, notePrefix) as { id: number; note: string | null }[];
  let migrated = 0;
  for (const row of rows) {
    migrated += migrateCheckingGastosCategoryToStableKey(accountId, row.id, row.note, dbHandle);
  }
  return migrated;
}

export type MigrateCheckingGastosCategoriesResult = {
  migrated_from_legacy: number;
  recovered_from_snapshot: number;
  orphaned_legacy_removed: number;
  stable_keys_total: number;
};

/** Migrate live `checking-mv:{id}` rows to stable keys; optionally recover orphans from a DB snapshot. */
export function migrateAllCheckingGastosCategoriesToStableKeys(opts?: {
  accountId?: number;
  snapshotDbPath?: string;
  dryRun?: boolean;
  dbHandle?: Database;
}): MigrateCheckingGastosCategoriesResult {
  const dbHandle = opts?.dbHandle ?? db;
  const dryRun = !!opts?.dryRun;
  let migratedFromLegacy = 0;
  let recoveredFromSnapshot = 0;
  let orphanedRemoved = 0;

  const accountFilter = opts?.accountId != null ? "AND m.account_id = ?" : "";
  const accountArgs = opts?.accountId != null ? [opts.accountId] : [];

  const liveRows = dbHandle
    .prepare(
      `SELECT m.id, m.account_id, m.note
       FROM movements m
       JOIN cc_expense_unique_purchases up ON up.purchase_key = 'checking-mv:' || m.id
       WHERE m.note LIKE 'import:cartola|%' ${accountFilter}`
    )
    .all(...accountArgs) as { id: number; account_id: number; note: string | null }[];

  const orphanRows = dbHandle
    .prepare(
      `SELECT up.account_id, up.purchase_key, up.category_id
       FROM cc_expense_unique_purchases up
       WHERE up.purchase_key LIKE 'checking-mv:%'
         AND NOT EXISTS (
           SELECT 1 FROM movements m
           WHERE up.purchase_key = 'checking-mv:' || m.id
             OR up.purchase_key = 'checking-mv:' || m.id || ':deposit'
         )
         ${opts?.accountId != null ? "AND up.account_id = ?" : ""}`
    )
    .all(...(opts?.accountId != null ? [opts.accountId] : [])) as {
    account_id: number;
    purchase_key: string;
    category_id: number | null;
  }[];

  let snapshotDb: DatabaseConstructor.Database | null = null;
  if (opts?.snapshotDbPath) {
    snapshotDb = new DatabaseConstructor(opts.snapshotDbPath, { readonly: true });
  }

  if (snapshotDb && !dryRun) {
    const snapRows = snapshotDb
      .prepare(
        `SELECT m.account_id, m.note, up.category_id, up.purchase_key
         FROM movements m
         JOIN cc_expense_unique_purchases up
           ON up.account_id = m.account_id
          AND (up.purchase_key = 'checking-mv:' || m.id
            OR up.purchase_key = 'checking-mv:' || m.id || ':deposit')
         WHERE m.note LIKE 'import:cartola|%'
           ${opts?.accountId != null ? "AND m.account_id = ?" : ""}`
      )
      .all(...(opts?.accountId != null ? [opts.accountId] : [])) as {
      account_id: number;
      note: string;
      category_id: number | null;
      purchase_key: string;
    }[];
    for (const row of snapRows) {
      const parsed = parseLegacyCheckingGastosPurchaseKey(row.purchase_key);
      if (!parsed) continue;
      const stableKey = checkingCartolaStablePurchaseKey(
        row.account_id,
        row.note,
        parsed.portion
      );
      if (!stableKey) continue;
      const stillExists = dbHandle
        .prepare(`SELECT 1 AS o FROM movements WHERE account_id = ? AND note = ?`)
        .get(row.account_id, row.note) as { o: number } | undefined;
      if (!stillExists) continue;
      upsertUniquePurchaseCategory(row.account_id, stableKey, row.category_id, dbHandle);
      migratePurchaseNotesKey(row.account_id, row.purchase_key, stableKey, dbHandle);
      recoveredFromSnapshot += 1;
    }
  } else if (snapshotDb && dryRun) {
    const snapCount = snapshotDb
      .prepare(
        `SELECT COUNT(*) AS c FROM movements m
         JOIN cc_expense_unique_purchases up
           ON up.account_id = m.account_id
          AND up.purchase_key LIKE 'checking-mv:' || m.id || '%'
         WHERE m.note LIKE 'import:cartola|%'
           ${opts?.accountId != null ? "AND m.account_id = ?" : ""}`
      )
      .get(...(opts?.accountId != null ? [opts.accountId] : [])) as { c: number };
    recoveredFromSnapshot = Number(snapCount.c) || 0;
  }

  const tx = dbHandle.transaction(() => {
    for (const row of liveRows) {
      if (!dryRun) {
        migratedFromLegacy += migrateCheckingGastosCategoryToStableKey(
          row.account_id,
          row.id,
          row.note,
          dbHandle
        );
      } else {
        migratedFromLegacy += 1;
      }
    }

    if (!dryRun) {
      for (const orphan of orphanRows) {
        const parsed = parseLegacyCheckingGastosPurchaseKey(orphan.purchase_key);
        if (!parsed) continue;
        const stableKey = checkingCartolaStablePurchaseKey(
          orphan.account_id,
          (
            dbHandle
              .prepare(`SELECT note FROM movements WHERE id = ? AND account_id = ?`)
              .get(parsed.movementId, orphan.account_id) as { note: string } | undefined
          )?.note,
          parsed.portion
        );
        if (stableKey) {
          const hasStable = dbHandle
            .prepare(
              `SELECT 1 AS o FROM cc_expense_unique_purchases
               WHERE account_id = ? AND purchase_key = ?`
            )
            .get(orphan.account_id, stableKey) as { o: number } | undefined;
          if (hasStable) {
            dbHandle
              .prepare(
                `DELETE FROM cc_expense_unique_purchases
                 WHERE account_id = ? AND purchase_key = ?`
              )
              .run(orphan.account_id, orphan.purchase_key);
            orphanedRemoved += 1;
          }
        }
      }
    }
  });
  tx();
  snapshotDb?.close();

  const stableTotal = (
    dbHandle
      .prepare(
        `SELECT COUNT(*) AS c FROM cc_expense_unique_purchases WHERE purchase_key LIKE 'checking-cartola:%'`
      )
      .get() as { c: number }
  ).c;

  return {
    migrated_from_legacy: migratedFromLegacy,
    recovered_from_snapshot: recoveredFromSnapshot,
    orphaned_legacy_removed: orphanedRemoved,
    stable_keys_total: stableTotal,
  };
}
