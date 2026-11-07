import { withChangeLogMuted } from "./cacheRegistry.js";
import { db } from "./db.js";

/**
 * Run `rederive` — a read path that rewrites derived rows (clear and re-insert) — so that it writes
 * nothing when it changes nothing: the rows of `tables` are compared before and after, leaving out
 * `ignoredColumns` (an insertion timestamp), and an unchanged result is rolled back to the savepoint
 * taken before it. Every write is a signal in the change log (`markInputTriggers.ts`): a re-derivation
 * that rewrote the same rows on every read dropped every cache that reads them, on every read.
 * The cache registry does not apply the log inside it (`withChangeLogMuted`): what is read there is
 * what the database holds after it either way.
 */
export function withoutChurn<T>(tables: readonly string[], ignoredColumns: readonly string[], rederive: () => T): T {
  const snapshot = (): string =>
    tables
      .map((table) => {
        const columns = (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[])
          .map((c) => c.name)
          .filter((c) => !ignoredColumns.includes(c));
        if (columns.length === 0) throw new Error(`withoutChurn: table ${table} does not exist`);
        const list = columns.map((c) => `"${c}"`).join(", ");
        return JSON.stringify(db.prepare(`SELECT ${list} FROM ${table} ORDER BY ${list}`).raw().all());
      })
      .join("\n");
  const before = snapshot();
  return withChangeLogMuted(() => {
    db.exec("SAVEPOINT without_churn");
    let released = false;
    try {
      const value = rederive();
      if (snapshot() === before) db.exec("ROLLBACK TO without_churn");
      db.exec("RELEASE without_churn");
      released = true;
      return value;
    } finally {
      if (!released) db.exec("RELEASE without_churn");
    }
  });
}
