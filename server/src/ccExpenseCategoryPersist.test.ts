import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { snapshotCcExpenseCategories } from "./ccExpenseCategoryPersist.js";
import {
  assignCcExpenseLineCategory,
  getCcExpenseCategoryBySlug,
  loadCcExpenseCategoryMaps,
  normalizeCcExpenseMerchantKey,
  resolveMerchantCategorySlug,
} from "./ccExpenseCategories.js";
import { importCcStatementsFromCsvRecords } from "./ccStatementsImport.js";
import { buildFlowsExpensesPayload } from "./flowsExpenses.js";
import { VITEST_SANTANDER_CC_MASTER_NOTES } from "./test/vitestDbSeed.js";

/**
 * All statements/rules here live on the ISOLATED vitest fixture master.
 * `importCcStatementsFromCsvRecords` has replaceAll semantics — pointing it at a shared
 * santander master (as this file once did) wipes that account's statements, which on the
 * generated test DB destroyed the demo card's data for every later run.
 */
function fixtureAccountId(): number {
  const row = db
    .prepare(`SELECT id FROM accounts WHERE notes = ?`)
    .get(VITEST_SANTANDER_CC_MASTER_NOTES) as { id: number } | undefined;
  if (!row) throw new Error("vitest CC fixture master missing (vitestDbSeed)");
  return row.id;
}

const SOURCE_PDF = "vitest-cat-persist.pdf";
const PARSER_ROW_ID = "vitest-cat-persist-row-1";
const MERCHANT = "VITEST PERSIST MERCHANT";

function seedRecord() {
  return {
    card_group: "santander",
    source_pdf: SOURCE_PDF,
    statement_date: "20/01/2025",
    period_from: "2024-12-21",
    period_to: "2025-01-20",
    card_last4: "",
    parser_layout: "compact",
    installment_flag: "false",
    amount_clp: "1000",
    merchant: MERCHANT,
    transaction_date: "01/01/2025",
    row_id: PARSER_ROW_ID,
    dedupe_key: "vitest-cat-persist-dedupe",
    raw_line: "01/01/2025 VITEST PERSIST MERCHANT $1.000",
    description_merged: "VITEST PERSIST MERCHANT",
  };
}

function cleanupFixtureAccount(accountId: number): void {
  db.prepare(
    `DELETE FROM cc_expense_line_categories WHERE statement_line_id IN (
       SELECT l.id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ?)`
  ).run(accountId);
  db.prepare(
    `DELETE FROM cc_statement_lines WHERE statement_id IN (
       SELECT id FROM cc_statements WHERE account_id = ?)`
  ).run(accountId);
  db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);
  db.prepare(`DELETE FROM expense_category_rules WHERE vendor LIKE 'VITEST%'`).run();
  db.prepare(`DELETE FROM cc_expense_unique_purchases WHERE account_id = ?`).run(accountId);
}

describe("ccExpenseCategoryPersist", () => {
  let accountId = 0;
  beforeAll(() => {
    accountId = fixtureAccountId();
    cleanupFixtureAccount(accountId);
  });
  afterAll(() => {
    cleanupFixtureAccount(accountId);
  });

  it("restores per-line override after reimport via parser_row_id", () => {
    importCcStatementsFromCsvRecords(accountId, [seedRecord()]);
    const line = db
      .prepare(
        `SELECT l.id FROM cc_statement_lines l
         JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ? AND l.parser_row_id = ?`
      )
      .get(accountId, PARSER_ROW_ID) as { id: number } | undefined;
    expect(line).toBeDefined();

    const supermarket = getCcExpenseCategoryBySlug("supermarket")!;
    db.prepare(
      `INSERT INTO cc_expense_line_categories (statement_line_id, category_id) VALUES (?, ?)
       ON CONFLICT(statement_line_id) DO UPDATE SET category_id = excluded.category_id`
    ).run(line!.id, supermarket.id);

    const snap = snapshotCcExpenseCategories(accountId);
    expect(snap.lineCategoryByParserRowId.get(PARSER_ROW_ID)).toBe(supermarket.id);

    importCcStatementsFromCsvRecords(accountId, [seedRecord()]);

    const newLine = db
      .prepare(
        `SELECT l.id FROM cc_statement_lines l
         JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ? AND l.parser_row_id = ?`
      )
      .get(accountId, PARSER_ROW_ID) as { id: number } | undefined;
    expect(newLine).toBeDefined();

    const cat = db
      .prepare(
        `SELECT c.slug FROM cc_expense_line_categories lc
         JOIN cc_expense_categories c ON c.id = lc.category_id
         WHERE lc.statement_line_id = ?`
      )
      .get(newLine!.id) as { slug: string } | undefined;
    expect(cat?.slug).toBe("supermarket");
  });

  it("category rules survive statement reimport", () => {
    importCcStatementsFromCsvRecords(accountId, [seedRecord()]);
    const line = db
      .prepare(
        `SELECT l.id, l.merchant FROM cc_statement_lines l
         JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ? AND l.parser_row_id = ?`
      )
      .get(accountId, PARSER_ROW_ID) as { id: number; merchant: string };

    assignCcExpenseLineCategory({
      statementLineId: line.id,
      unique: false,
      categorySlug: "fun",
    });

    const merchantKey = normalizeCcExpenseMerchantKey(line.merchant);
    const before = resolveMerchantCategorySlug(merchantKey, loadCcExpenseCategoryMaps([accountId]).merchantRules);
    expect(before).toBe("fun");

    importCcStatementsFromCsvRecords(accountId, []);

    const after = resolveMerchantCategorySlug(merchantKey, loadCcExpenseCategoryMaps([accountId]).merchantRules);
    expect(after).toBe("fun");

    const payload = buildFlowsExpensesPayload();
    const hit = payload.lines.find((ln) => ln.statement_line_id === line.id);
    if (hit && normalizeCcExpenseMerchantKey(hit.merchant) === merchantKey) {
      expect(hit.category_slug).toBe("fun");
    }
  });
});
