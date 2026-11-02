import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { movePropertyAppraisalsIntoValuations260 } from "./valuationsAnyCurrency260.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migration260 = fs.readFileSync(path.join(here, "..", "migrations", "260_valuations_any_currency.sql"), "utf8");

/** A scratch DB with `valuations` and `property_appraisals` as they stood before migration 260. */
function db259() {
  const dbi = new Database(":memory:");
  dbi.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY);
    CREATE TABLE valuations (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      as_of_date TEXT NOT NULL,
      value REAL NOT NULL, units_snapshot REAL, currency TEXT NOT NULL DEFAULT 'clp' CHECK (currency IN ('clp', 'usd')),
      UNIQUE(account_id, as_of_date)
    );
    CREATE TABLE property_appraisals (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      as_of_date TEXT NOT NULL, value REAL NOT NULL,
      currency TEXT NOT NULL CHECK (currency IN ('clp', 'usd', 'eur', 'uf')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (account_id, as_of_date)
    );
    INSERT INTO accounts (id) VALUES (1), (2);
    INSERT INTO valuations (account_id, as_of_date, value, units_snapshot) VALUES
      (1, '2030-01-31', 50000000, NULL), (1, '2030-02-11', 51000000, NULL), (2, '2030-01-31', 1200, 3.5);
    INSERT INTO property_appraisals (account_id, as_of_date, value, currency) VALUES
      (1, '2030-01-11', 5400, 'uf'), (1, '2030-02-11', 5400, 'uf');
  `);
  for (const stmt of migration260.split(";").map((s) => s.trim()).filter((s) => s && !/^--[^\n]*$/.test(s))) {
    dbi.exec(stmt);
  }
  return dbi;
}

describe("migration 260: valuations in any currency", () => {
  it("keeps every row and takes any lowercase currency code", () => {
    const dbi = db259();
    expect(dbi.prepare(`SELECT account_id, as_of_date, value, units_snapshot, currency FROM valuations WHERE account_id = 2`).all()).toEqual([
      { account_id: 2, as_of_date: "2030-01-31", value: 1200, units_snapshot: 3.5, currency: "clp" },
    ]);
    dbi.prepare(`INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (2, '2030-03-31', 1, 'uf')`).run();
    dbi.prepare(`INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (2, '2030-04-30', 1, 'eur')`).run();
    for (const bad of ["UF", "u", "c1p", "usdollars"]) {
      expect(() =>
        dbi.prepare(`INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (2, '2030-05-31', 1, ?)`).run(bad)
      ).toThrow(/CHECK/);
    }
  });

  it("replaces the property's peso rows with its UF appraisals and drops property_appraisals", () => {
    const dbi = db259();
    movePropertyAppraisalsIntoValuations260(dbi);
    expect(dbi.prepare(`SELECT account_id, as_of_date, value, currency FROM valuations ORDER BY account_id, as_of_date`).all()).toEqual([
      { account_id: 1, as_of_date: "2030-01-11", value: 5400, currency: "uf" },
      { account_id: 1, as_of_date: "2030-02-11", value: 5400, currency: "uf" },
      { account_id: 2, as_of_date: "2030-01-31", value: 1200, currency: "clp" },
    ]);
    expect(dbi.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'property_appraisals'`).get()).toBeUndefined();
  });

  it("does nothing to the data on a DB without property_appraisals", () => {
    const dbi = db259();
    dbi.exec(`DROP TABLE property_appraisals`);
    movePropertyAppraisalsIntoValuations260(dbi);
    expect((dbi.prepare(`SELECT COUNT(*) AS c FROM valuations`).get() as { c: number }).c).toBe(3);
  });
});
