import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Migration 384 hook: `vendor_catalog.source` takes `spelling` (a carried spelling,
 * `checkingRestatementCarry.ts`). SQLite cannot widen a CHECK in place: the table is rebuilt with
 * its rows and ids, and its triggers (the write log) are re-created as they were, in their order.
 * Pure (no `db` import — the module graph is still initializing).
 */
export function runVendorCatalogSpelling384(dbi: DatabaseType): void {
  const triggers = dbi.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'vendor_catalog' ORDER BY rowid`).all() as {
    name: string;
    sql: string;
  }[];
  const count = () => (dbi.prepare(`SELECT COUNT(*) AS n FROM vendor_catalog`).get() as { n: number }).n;
  const rows = count();
  dbi.exec(`CREATE TABLE vendor_catalog_next (
  id INTEGER PRIMARY KEY,
  match_kind TEXT NOT NULL CHECK (match_kind IN ('exact', 'prefix', 'branch', 'rut')),
  pattern TEXT NOT NULL CHECK (pattern <> ''),
  display TEXT NOT NULL CHECK (display <> ''),
  source TEXT NOT NULL CHECK (source IN ('seed', 'user', 'choice', 'spelling')),
  UNIQUE (match_kind, pattern, source)
)`);
  dbi.exec(`INSERT INTO vendor_catalog_next (id, match_kind, pattern, display, source) SELECT id, match_kind, pattern, display, source FROM vendor_catalog`);
  dbi.exec(`DROP TABLE vendor_catalog`);
  dbi.exec(`ALTER TABLE vendor_catalog_next RENAME TO vendor_catalog`);
  for (const t of triggers) dbi.exec(t.sql);
  if (count() !== rows) throw new Error(`migration 384: vendor_catalog had ${rows} rows, has ${count()}`);
  const after = (dbi.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'vendor_catalog' ORDER BY rowid`).all() as { name: string }[]).map((r) => r.name);
  if (after.join(",") !== triggers.map((t) => t.name).join(",")) throw new Error(`migration 384: vendor_catalog triggers ${after.join(",")} ≠ ${triggers.map((t) => t.name).join(",")}`);
}
