import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Re-creates the named triggers of `table` with new text, keeping the table's trigger order: SQLite
 * fires a table's triggers newest first and the change log depends on that order, so every trigger
 * of the table is dropped and re-created in its original creation order, only the named ones with
 * new text. A named trigger the table does not have throws; one already equal is left as it is.
 * Returns the names re-created with new text. Pure: no `db` import (migration hooks run it).
 */
export function reinstallTableTriggersInOrder(
  dbi: DatabaseType,
  table: string,
  replacements: Readonly<Record<string, string>>,
  label: string
): string[] {
  const list = () =>
    dbi
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY rowid`)
      .all(table) as { name: string; sql: string }[];
  const triggers = list();
  const byName = new Map(triggers.map((t) => [t.name, t]));
  for (const name of Object.keys(replacements)) {
    if (!byName.has(name)) throw new Error(`${label}: trigger ${name} is not installed on ${table}`);
  }
  const changed = Object.entries(replacements)
    .filter(([name, sql]) => byName.get(name)!.sql !== sql)
    .map(([name]) => name);
  if (changed.length === 0) return [];
  for (const t of triggers) dbi.exec(`DROP TRIGGER "${t.name}"`);
  for (const t of triggers) dbi.exec(replacements[t.name] ?? t.sql);
  const after = list();
  const names = (rows: { name: string }[]) => rows.map((r) => r.name).join(",");
  if (names(after) !== names(triggers)) {
    throw new Error(`${label}: ${table} triggers changed order (${names(triggers)} → ${names(after)})`);
  }
  for (const [name, sql] of Object.entries(replacements)) {
    if (after.find((t) => t.name === name)?.sql !== sql) throw new Error(`${label}: ${name} was not replaced`);
  }
  return changed;
}
