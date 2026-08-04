import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Migration 169 hook: rebuild `movements` from the legacy amount_clp/amount_usd pair to
 * native `amount` + `currency`, with `counter_amount`/`counter_currency` carrying the
 * to-leg of cross-currency transfers (compra_usd_venta_clp: amount = CLP from-leg,
 * counter = USD to-leg).
 *
 * Backfill mapping (must be unambiguous — asserted below, throw = transaction rollback):
 *   - amount_clp only            → ('clp', amount_clp)
 *   - amount_usd only (clp = 0)  → ('usd', amount_usd)
 *   - both legs (transfers only) → ('clp', amount_clp) + counter ('usd', amount_usd)
 *
 * Runs inside the migration transaction with foreign_keys=OFF (arranged by db.ts):
 * DROP TABLE under foreign_keys=ON performs an implicit DELETE whose ON DELETE CASCADE
 * actions wipe every child table. Integrity is re-checked via PRAGMA foreign_key_check
 * before the hook returns.
 */
export function runMovementsAmountCurrency169(dbi: DatabaseType): void {
  if (dbi.pragma("foreign_keys", { simple: true }) !== 0) {
    throw new Error(
      "migration 169 requires foreign_keys=OFF for the movements rebuild " +
        "(DROP TABLE would cascade-delete child-table rows); db.ts must list it in FOREIGN_KEYS_OFF_MIGRATIONS"
    );
  }

  const count = (sql: string): number => (dbi.prepare(sql).get() as { n: number }).n;

  const bothZero = count(
    "SELECT COUNT(*) AS n FROM movements WHERE COALESCE(amount_clp, 0) = 0 AND COALESCE(amount_usd, 0) = 0"
  );
  if (bothZero > 0) {
    throw new Error(`migration 169: ${bothZero} movements carry neither a CLP nor a USD amount — fix rows first`);
  }
  const usdExplicitZero = count(
    "SELECT COUNT(*) AS n FROM movements WHERE amount_usd IS NOT NULL AND amount_usd = 0"
  );
  if (usdExplicitZero > 0) {
    throw new Error(
      `migration 169: ${usdExplicitZero} movements store an explicit amount_usd = 0 — ambiguous, fix rows first`
    );
  }
  const bothLegSingle = count(
    "SELECT COUNT(*) AS n FROM movements WHERE amount_clp != 0 AND COALESCE(amount_usd, 0) != 0 AND from_account_id IS NULL"
  );
  if (bothLegSingle > 0) {
    throw new Error(
      `migration 169: ${bothLegSingle} single-leg movements carry both CLP and USD amounts — only cross-currency transfers may`
    );
  }

  dbi.exec(`CREATE TABLE movements_new (
  id INTEGER PRIMARY KEY,
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  from_account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  to_account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('clp', 'usd', 'eur')),
  counter_amount REAL,
  counter_currency TEXT CHECK (counter_currency IN ('clp', 'usd', 'eur')),
  occurred_on TEXT NOT NULL,
  note TEXT,
  units_delta REAL,
  flow_kind TEXT,
  ticker TEXT,
  CHECK (
    (
      account_id IS NOT NULL
      AND from_account_id IS NULL
      AND to_account_id IS NULL
    )
    OR (
      account_id IS NULL
      AND from_account_id IS NOT NULL
      AND to_account_id IS NOT NULL
      AND from_account_id != to_account_id
    )
  ),
  CHECK ((counter_amount IS NULL) = (counter_currency IS NULL)),
  CHECK (counter_currency IS NULL OR (counter_currency != currency AND from_account_id IS NOT NULL))
)`);

  dbi.exec(`INSERT INTO movements_new (
  id, account_id, from_account_id, to_account_id,
  amount, currency, counter_amount, counter_currency,
  occurred_on, note, units_delta, flow_kind, ticker
)
SELECT
  id, account_id, from_account_id, to_account_id,
  CASE WHEN amount_clp = 0 THEN amount_usd ELSE amount_clp END,
  CASE WHEN amount_clp = 0 THEN 'usd' ELSE 'clp' END,
  CASE WHEN amount_clp != 0 AND COALESCE(amount_usd, 0) != 0 THEN amount_usd ELSE NULL END,
  CASE WHEN amount_clp != 0 AND COALESCE(amount_usd, 0) != 0 THEN 'usd' ELSE NULL END,
  occurred_on, note, units_delta, flow_kind, ticker
FROM movements`);

  // Per-row exact round-trip: re-deriving the legacy pair from the new columns must
  // reproduce the old table bit-for-bit (REAL copies are exact; IS NOT handles NULLs).
  const mismatches = count(`SELECT COUNT(*) AS n
FROM movements o JOIN movements_new nw ON nw.id = o.id
WHERE (CASE WHEN nw.currency = 'clp' THEN nw.amount WHEN nw.counter_currency = 'clp' THEN nw.counter_amount ELSE 0 END) IS NOT o.amount_clp
   OR (CASE WHEN nw.currency = 'usd' THEN nw.amount WHEN nw.counter_currency = 'usd' THEN nw.counter_amount END) IS NOT o.amount_usd`);
  if (mismatches > 0) {
    throw new Error(`migration 169: backfill round-trip mismatch on ${mismatches} rows`);
  }
  const oldCount = count("SELECT COUNT(*) AS n FROM movements");
  const newCount = count("SELECT COUNT(*) AS n FROM movements_new");
  if (oldCount !== newCount) {
    throw new Error(`migration 169: row count drifted (${oldCount} -> ${newCount})`);
  }

  dbi.exec("DROP TABLE movements");
  dbi.exec("ALTER TABLE movements_new RENAME TO movements");
  dbi.exec("CREATE INDEX idx_movements_account_occurred ON movements(account_id, occurred_on)");
  dbi.exec("CREATE INDEX idx_movements_from_occurred ON movements(from_account_id, occurred_on)");
  dbi.exec("CREATE INDEX idx_movements_to_occurred ON movements(to_account_id, occurred_on)");

  const fkViolations = dbi.pragma("foreign_key_check") as unknown[];
  if (fkViolations.length > 0) {
    throw new Error(
      `migration 169: foreign_key_check reports ${fkViolations.length} violation(s) after the movements rebuild`
    );
  }
}
