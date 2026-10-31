import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { planExpenseCategoryRuleMigration } from "./expenseCategoryRulesMigration.js";

function oldSchemaDb() {
  const dbi = new Database(":memory:");
  dbi.exec(`
    CREATE TABLE vendor_catalog (id INTEGER PRIMARY KEY, match_kind TEXT, pattern TEXT, display TEXT, source TEXT);
    CREATE TABLE cc_expense_merchant_categories (account_id INTEGER, merchant_key TEXT, category_id INTEGER);
    INSERT INTO vendor_catalog (match_kind, pattern, display, source) VALUES ('branch', 'JUMBO', 'Jumbo', 'seed');
  `);
  return dbi;
}

describe("migration 252: per-account merchant rules → global vendor rules", () => {
  it("merges every account's rule for one vendor, branches of a brand included", () => {
    const dbi = oldSchemaDb();
    dbi.exec(`INSERT INTO cc_expense_merchant_categories VALUES
      (1, 'JUMBO BILBAO', 10), (2, 'JUMBO BILBAO', 10), (1, 'JUMBO PENALOLEN', 10), (1, 'ZARA', 20), (2, 'ZARA', 20)`);
    const plan = planExpenseCategoryRuleMigration(dbi);
    expect(plan.map((r) => [r.vendor, r.category_id, r.conflict, r.sources.length])).toEqual([
      ["JUMBO", 10, false, 3],
      ["ZARA", 20, false, 2],
    ]);
  });

  it("a vendor whose old rules disagree takes the category most rules carry, and is flagged", () => {
    const dbi = oldSchemaDb();
    dbi.exec(`INSERT INTO cc_expense_merchant_categories VALUES (1, 'SHOP', 30), (2, 'SHOP', 31), (3, 'SHOP', 31)`);
    const [rule] = planExpenseCategoryRuleMigration(dbi);
    expect(rule).toMatchObject({ vendor: "SHOP", category_id: 31, conflict: true });
  });

  it("does nothing once the old table is gone", () => {
    const dbi = new Database(":memory:");
    expect(planExpenseCategoryRuleMigration(dbi)).toEqual([]);
  });
});
