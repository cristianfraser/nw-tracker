import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const migration261 = fs.readFileSync(path.join(here, "..", "migrations", "261_drop_mortgage_valuations.sql"), "utf8");

it("261 deletes the mortgage's stored valuations and nobody else's", () => {
  const dbi = new Database(":memory:");
  dbi.exec(`
    CREATE TABLE asset_groups (id INTEGER PRIMARY KEY, slug TEXT NOT NULL);
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, asset_group_id INTEGER NOT NULL);
    CREATE TABLE valuations (account_id INTEGER NOT NULL, as_of_date TEXT NOT NULL, value REAL NOT NULL, currency TEXT NOT NULL);
    INSERT INTO asset_groups (id, slug) VALUES (1, 'liabilities__mortgage'), (2, 'real_estate__property'), (3, 'liabilities__mortgagexyz'), (4, 'cash_eqs__dap');
    INSERT INTO accounts (id, asset_group_id) VALUES (10, 1), (11, 2), (12, 3), (13, 4);
    INSERT INTO valuations VALUES (10, '2030-01-31', 1, 'clp'), (10, '2030-02-28', 2, 'clp'),
      (11, '2030-01-31', 5400, 'uf'), (12, '2030-01-31', 3, 'clp'), (13, '2030-01-31', 4, 'clp');
  `);
  dbi.exec(migration261.split("\n").filter((l) => !l.startsWith("--")).join("\n"));
  const left = dbi.prepare(`SELECT account_id FROM valuations ORDER BY account_id`).all() as { account_id: number }[];
  expect(left.map((r) => r.account_id)).toEqual([11, 12, 13]);
});
