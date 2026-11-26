/**
 * The migration runner (`runMigrationsIn`, db.ts) on a scratch database and a folder of the test's
 * own migration files: a migration is all or nothing — recorded only when every statement, its
 * hook and (for a foreign-keys-off migration) the reference check pass.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrationsIn } from "./db.js";

let dir = "";
let dbi: DatabaseType;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-migrations-"));
  dbi = new Database(":memory:");
  dbi.pragma("foreign_keys = ON");
  dbi.exec(`CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  dbi.exec(`CREATE TABLE parent (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`);
  dbi.exec(`CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE)`);
  dbi.exec(`INSERT INTO parent (id, label) VALUES (1, 'one'), (2, 'two')`);
  dbi.exec(`INSERT INTO child (id, parent_id) VALUES (10, 1), (20, 2)`);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  dbi.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function migration(name: string, sql: string): void {
  fs.writeFileSync(path.join(dir, name), sql);
}

function run(opts?: { foreignKeysOff?: string[]; hooks?: Record<string, (d: DatabaseType) => void> }): void {
  runMigrationsIn(dbi, { dir, foreignKeysOff: new Set(opts?.foreignKeysOff ?? []), hooks: opts?.hooks ?? {} });
}

const applied = () => (dbi.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as { id: string }[]).map((r) => r.id);
const columns = (t: string) => (dbi.prepare(`SELECT name FROM pragma_table_info(?)`).all(t) as { name: string }[]).map((c) => c.name);
const tableExists = (t: string) => dbi.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t) != null;

/** Rebuild `parent` with an extra column, the way FK-off migrations rebuild a referenced table. */
const rebuildParent = (idExpr: string) => `
  CREATE TABLE parent_new (id INTEGER PRIMARY KEY, label TEXT NOT NULL, note TEXT);
  INSERT INTO parent_new (id, label) SELECT ${idExpr}, label FROM parent;
  DROP TABLE parent;
  ALTER TABLE parent_new RENAME TO parent;
`;

describe("runMigrationsIn: foreign-keys-off migrations", () => {
  it("rebuilds a referenced table without cascading into its children, then records it", () => {
    migration("001_rebuild_parent.sql", rebuildParent("id"));

    run({ foreignKeysOff: ["001_rebuild_parent.sql"] });

    expect(applied()).toEqual(["001_rebuild_parent.sql"]);
    expect(columns("parent")).toContain("note");
    expect(dbi.prepare(`SELECT id, parent_id FROM child ORDER BY id`).all()).toEqual([
      { id: 10, parent_id: 1 },
      { id: 20, parent_id: 2 },
    ]);
    expect(dbi.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("throws naming the migration when it leaves a dangling reference, and keeps nothing of it", () => {
    migration("001_rebuild_parent.sql", rebuildParent("id + 100"));
    migration("002_later.sql", `CREATE TABLE later (id INTEGER PRIMARY KEY)`);

    expect(() => run({ foreignKeysOff: ["001_rebuild_parent.sql"] })).toThrow(
      /migration 001_rebuild_parent\.sql: 2 foreign key violation\(s\)/
    );

    expect(applied()).toEqual([]);
    expect(columns("parent")).toEqual(["id", "label"]);
    expect(dbi.prepare(`SELECT id FROM parent ORDER BY id`).all()).toEqual([{ id: 1 }, { id: 2 }]);
    expect(tableExists("parent_new")).toBe(false);
    expect(dbi.prepare(`SELECT COUNT(*) AS n FROM child`).get()).toEqual({ n: 2 });
    // The run stopped there, and the connection is back to enforcing references.
    expect(tableExists("later")).toBe(false);
    expect(dbi.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("checks references left broken by the migration's hook too", () => {
    migration("001_rebuild_parent.sql", rebuildParent("id"));
    const hooks = { "001_rebuild_parent.sql": (d: DatabaseType) => d.exec(`DELETE FROM parent WHERE id = 2`) };

    expect(() => run({ foreignKeysOff: ["001_rebuild_parent.sql"], hooks })).toThrow(/001_rebuild_parent\.sql/);

    expect(applied()).toEqual([]);
    expect(dbi.prepare(`SELECT COUNT(*) AS n FROM parent`).get()).toEqual({ n: 2 });
  });
});

describe("runMigrationsIn: a failing migration", () => {
  it("that fails on its second statement leaves no partial change and is not recorded", () => {
    migration("001_ok.sql", `CREATE TABLE first_ok (id INTEGER PRIMARY KEY)`);
    migration(
      "002_breaks.sql",
      `ALTER TABLE parent ADD COLUMN extra TEXT;
       INSERT INTO no_such_table VALUES (1);
       CREATE TABLE never (id INTEGER PRIMARY KEY);`
    );
    migration("003_after.sql", `CREATE TABLE after_break (id INTEGER PRIMARY KEY)`);

    expect(() => run()).toThrow(/no such table: no_such_table/);

    expect(applied()).toEqual(["001_ok.sql"]);
    expect(tableExists("first_ok")).toBe(true);
    expect(columns("parent")).toEqual(["id", "label"]);
    expect(tableExists("never")).toBe(false);
    expect(tableExists("after_break")).toBe(false);
  });

  it("whose hook throws keeps none of its SQL", () => {
    migration("001_with_hook.sql", `ALTER TABLE parent ADD COLUMN extra TEXT`);
    const hooks = {
      "001_with_hook.sql": (d: DatabaseType) => {
        d.exec(`UPDATE parent SET extra = 'x'`);
        throw new Error("hook refused the data");
      },
    };

    expect(() => run({ hooks })).toThrow(/hook refused the data/);

    expect(applied()).toEqual([]);
    expect(columns("parent")).toEqual(["id", "label"]);
  });

  it("is retried whole by the next run once fixed, and an applied one never runs twice", () => {
    migration("001_add.sql", `ALTER TABLE parent ADD COLUMN extra TEXT; INSERT INTO nope VALUES (1)`);
    expect(() => run()).toThrow();

    migration("001_add.sql", `ALTER TABLE parent ADD COLUMN extra TEXT; UPDATE parent SET extra = 'set'`);
    run();
    // Re-running would fail on the duplicate column: the recorded migration is skipped.
    run();

    expect(applied()).toEqual(["001_add.sql"]);
    expect(dbi.prepare(`SELECT DISTINCT extra FROM parent`).all()).toEqual([{ extra: "set" }]);
  });
});
