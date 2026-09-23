import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Migration 178 hook: rebuild `grocery_receipts` with a NOT NULL UNIQUE `receipt_key` — the
 * receipt's natural identity `<chain>|<receipt_number>|<YYYY-MM-DD>` — so one boleta reaching
 * the pipeline through two documents (the «Boleta Digital» e-mail and a photo of the paper
 * copy) lands on one row. `source` / `source_key` stay as provenance of the document that owns
 * the row (UNIQUE per document); which document wins is decided by the importer's source rank
 * (`groceryReceiptsImport.ts`), not here. The backfill formula below MUST equal
 * `groceryReceiptKey` in that module.
 *
 * Runs inside the migration transaction with foreign_keys=OFF (arranged by db.ts):
 * `grocery_receipt_items` references this table ON DELETE CASCADE, so DROP TABLE under
 * foreign_keys=ON would perform an implicit DELETE that wipes every item. Integrity is
 * re-checked via PRAGMA foreign_key_check before the hook returns (throw = rollback).
 */
export function runGroceryReceiptKey178(dbi: DatabaseType): void {
  if (dbi.pragma("foreign_keys", { simple: true }) !== 0) {
    throw new Error(
      "migration 178 requires foreign_keys=OFF for the grocery_receipts rebuild " +
        "(DROP TABLE would cascade-delete grocery_receipt_items); db.ts must list it in FOREIGN_KEYS_OFF_MIGRATIONS"
    );
  }

  const count = (sql: string): number => (dbi.prepare(sql).get() as { n: number }).n;
  const KEY_SQL = "store_chain || '|' || receipt_number || '|' || substr(purchased_at, 1, 10)";

  const receiptsBefore = count("SELECT COUNT(*) AS n FROM grocery_receipts");
  const itemsBefore = count("SELECT COUNT(*) AS n FROM grocery_receipt_items");
  const distinctKeys = count(`SELECT COUNT(DISTINCT ${KEY_SQL}) AS n FROM grocery_receipts`);
  if (distinctKeys !== receiptsBefore) {
    throw new Error(
      `migration 178: ${receiptsBefore - distinctKeys} receipt(s) share a (chain, receipt number, date) identity — resolve the duplicate rows first`
    );
  }
  const badDates = count(
    "SELECT COUNT(*) AS n FROM grocery_receipts WHERE substr(purchased_at, 1, 10) NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'"
  );
  if (badDates > 0) {
    throw new Error(`migration 178: ${badDates} receipt(s) carry a purchased_at that is not 'YYYY-MM-DD …' — fix rows first`);
  }

  dbi.exec(`CREATE TABLE grocery_receipts_new (
  id INTEGER PRIMARY KEY,
  -- Natural identity: '<store_chain>|<receipt_number>|<YYYY-MM-DD>' (see groceryReceiptKey).
  receipt_key TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  -- Stable per-document identity from the source (e-mail message id, photo sha256, …).
  source_key TEXT NOT NULL UNIQUE,
  receipt_number TEXT NOT NULL,
  store_chain TEXT NOT NULL,
  branch TEXT NOT NULL,
  city TEXT,
  -- Local (Chile) datetime printed on the receipt: 'YYYY-MM-DD HH:MM:SS'.
  purchased_at TEXT NOT NULL,
  total_clp INTEGER NOT NULL,
  -- Σ item-level discounts only; receipt-level rebates live in receipt_discount_clp.
  discount_total_clp INTEGER NOT NULL DEFAULT 0,
  receipt_discount_clp INTEGER NOT NULL DEFAULT 0,
  receipt_discounts_json TEXT,
  -- JSON array of payment legs [{method, amount_clp}]; card_paid_clp is the chain card leg's sum.
  payments_json TEXT NOT NULL,
  card_paid_clp INTEGER NOT NULL DEFAULT 0,
  mi_club_points INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
  dbi.exec(`INSERT INTO grocery_receipts_new (
  id, receipt_key, source, source_key, receipt_number, store_chain, branch, city, purchased_at,
  total_clp, discount_total_clp, receipt_discount_clp, receipt_discounts_json, payments_json,
  card_paid_clp, mi_club_points, created_at
) SELECT
  id, ${KEY_SQL}, source, source_key, receipt_number, store_chain, branch, city, purchased_at,
  total_clp, discount_total_clp, receipt_discount_clp, receipt_discounts_json, payments_json,
  card_paid_clp, mi_club_points, created_at
FROM grocery_receipts`);
  const receiptsNew = count("SELECT COUNT(*) AS n FROM grocery_receipts_new");
  if (receiptsNew !== receiptsBefore) {
    throw new Error(`migration 178: row count drifted (${receiptsBefore} -> ${receiptsNew})`);
  }

  dbi.exec("DROP TABLE grocery_receipts");
  dbi.exec("ALTER TABLE grocery_receipts_new RENAME TO grocery_receipts");
  dbi.exec("CREATE INDEX idx_grocery_receipts_purchased ON grocery_receipts(purchased_at)");

  const itemsAfter = count("SELECT COUNT(*) AS n FROM grocery_receipt_items");
  if (itemsAfter !== itemsBefore) {
    throw new Error(`migration 178: grocery_receipt_items count drifted (${itemsBefore} -> ${itemsAfter})`);
  }
  const orphans = count(
    "SELECT COUNT(*) AS n FROM grocery_receipt_items i LEFT JOIN grocery_receipts r ON r.id = i.receipt_id WHERE r.id IS NULL"
  );
  if (orphans > 0) {
    throw new Error(`migration 178: ${orphans} grocery_receipt_items row(s) lost their receipt in the rebuild`);
  }
  const fkViolations = dbi.pragma("foreign_key_check") as unknown[];
  if (fkViolations.length > 0) {
    throw new Error(
      `migration 178: foreign_key_check reports ${fkViolations.length} violation(s) after the grocery_receipts rebuild`
    );
  }
}
