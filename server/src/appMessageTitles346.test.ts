import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { rolledBack } from "./ingestReceiver.js";

const MIGRATION = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
  "346_app_message_titles_drop_timestamp.sql"
);

/** The migration's one statement, comments stripped the way the runner strips them. */
function migrationSql(): string {
  return fs.readFileSync(MIGRATION, "utf8").replace(/--[^\n]*/g, "");
}

describe("migration 346: message titles lose the legacy timestamp suffix", () => {
  it("strips exactly the trailing « YYYY-MM-DD HH:MM:SS UTC» and nothing else", () => {
    rolledBack(() => {
      const insert = db.prepare(`INSERT INTO app_messages (kind, title, body) VALUES ('log', ?, 'vitest-346')`);
      const titles = [
        "Vitest sync 2031-02-03 04:05:06 UTC",
        "Vitest sync",
        "Vitest sync 2031-02-03 04:05:06 UTC and more",
        "Vitest sync 2031-02-03 04:05 UTC",
        "Vitest sync 2031-02-03 04:05:06 UTC 2031-02-04 01:02:03 UTC",
      ];
      const ids = titles.map((t) => Number(insert.run(t).lastInsertRowid));
      db.exec(migrationSql());
      const after = ids.map((id) => (db.prepare(`SELECT title FROM app_messages WHERE id = ?`).get(id) as { title: string }).title);
      expect(after).toEqual([
        "Vitest sync",
        "Vitest sync",
        "Vitest sync 2031-02-03 04:05:06 UTC and more",
        "Vitest sync 2031-02-03 04:05 UTC",
        "Vitest sync 2031-02-03 04:05:06 UTC",
      ]);
      // Once applied, nothing is left for a second pass on the titles that had one suffix.
      db.exec(migrationSql());
      expect((db.prepare(`SELECT title FROM app_messages WHERE id = ?`).get(ids[0]) as { title: string }).title).toBe("Vitest sync");
    });
  });
});
