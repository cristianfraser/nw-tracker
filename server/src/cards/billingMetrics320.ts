import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "../markInputTriggers.js";

/**
 * Migration 320 hook (docs/any-currency-plan.md, Phase C3): a card's stored billing-month snapshot
 * becomes a long table, one row per (month, as-of, metric, currency) —
 * `cc_billing_month_metrics(account_id, billing_month, as_of_date, as_of_kind, metric, currency,
 * amount)` — instead of `cc_billing_month_balances`' fixed pairs (`facturado_clp` /
 * `facturado_usd`, `saldo_total_clp` / `_usd`, `cupo_utilizado_clp`). A metric the old row left
 * NULL has no row. The table is a derived cache (`recomputeCcBillingMonthBalances` rebuilds a card
 * whole), so nothing references it; its write-log triggers are the generic ones over its columns.
 * Pure apart from the trigger builder (no `db` import: the module graph is still loading).
 */

const METRICS = [
  ["facturado", "clp", "facturado_clp"],
  ["facturado", "usd", "facturado_usd"],
  ["cupo_utilizado", "clp", "cupo_utilizado_clp"],
  ["saldo_total", "clp", "saldo_total_clp"],
  ["saldo_total", "usd", "saldo_total_usd"],
] as const;

export const CC_BILLING_MONTH_METRICS_TABLE = `CREATE TABLE cc_billing_month_metrics (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  billing_month TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  as_of_kind TEXT NOT NULL CHECK (as_of_kind IN ('statement', 'month_end', 'manual')),
  metric TEXT NOT NULL CHECK (metric IN ('facturado', 'cupo_utilizado', 'saldo_total')),
  currency TEXT NOT NULL REFERENCES currencies(code),
  amount REAL NOT NULL,
  UNIQUE (account_id, billing_month, as_of_date, as_of_kind, metric, currency)
)`;

export function runBillingMetrics320(dbi: DatabaseType): void {
  // A fresh database never has the old table (the baseline no longer creates it).
  const hasOld = dbi.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cc_billing_month_balances'`).get() != null;
  const before = hasOld ? (dbi.prepare(`SELECT COUNT(*) AS c FROM cc_billing_month_balances`).get() as { c: number }).c : 0;
  dbi.exec(CC_BILLING_MONTH_METRICS_TABLE);
  dbi.exec(`CREATE INDEX idx_cc_billing_month_metrics_account ON cc_billing_month_metrics(account_id, billing_month)`);
  // Rows in the old table's order, each metric in the old column order, so the pivot's MIN(id)
  // keeps the old rows' order.
  const insert = dbi.prepare(
    `INSERT INTO cc_billing_month_metrics (account_id, billing_month, as_of_date, as_of_kind, metric, currency, amount)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const rows = hasOld
    ? (dbi.prepare(`SELECT * FROM cc_billing_month_balances ORDER BY id`).all() as Record<string, unknown>[])
    : [];
  let written = 0;
  for (const r of rows) {
    for (const [metric, currency, column] of METRICS) {
      const v = r[column];
      if (v == null) continue;
      insert.run(r.account_id, r.billing_month, r.as_of_date, r.as_of_kind, metric, currency, v);
      written += 1;
    }
  }
  const groups = (
    dbi
      .prepare(
        `SELECT COUNT(*) AS c FROM (SELECT 1 FROM cc_billing_month_metrics
         GROUP BY account_id, billing_month, as_of_date, as_of_kind)`
      )
      .get() as { c: number }
  ).c;
  if (groups !== before) throw new Error(`migration 320: ${before} snapshot row(s), ${groups} after the split`);
  if (hasOld) dbi.exec(`DROP TABLE cc_billing_month_balances`);
  const columns = (dbi.prepare(`SELECT name FROM pragma_table_info('cc_billing_month_metrics')`).all() as { name: string }[]).map(
    (c) => c.name
  );
  for (const sql of writeLogTriggerSql("cc_billing_month_metrics", columns, null)) dbi.exec(sql);
  console.log(`migration 320: ${before} billing-month snapshot row(s) → ${written} metric row(s)`);
}
