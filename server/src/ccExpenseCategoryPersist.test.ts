import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  propagateCcExpenseMerchantRulesFromLegacy,
  restoreCcExpenseCategories,
  snapshotCcExpenseCategories,
} from "./ccExpenseCategoryPersist.js";
import {
  assignCcExpenseLineCategory,
  getCcExpenseCategoryBySlug,
  loadCcExpenseCategoryMaps,
  normalizeCcExpenseMerchantKey,
  resolveCcExpensePurchaseKey,
} from "./ccExpenseCategories.js";
import { importCcStatementsFromCsvRecords } from "./ccStatementsImport.js";
import { listCreditCardGroupMasterAccountIds } from "./creditCardTree.js";
import { buildFlowsCreditCardExpensesPayload } from "./flowsCreditCardExpenses.js";

describe("ccExpenseCategoryPersist", () => {
  it("propagates merchant rules from legacy master onto per-card accounts", () => {
    const ids = listCreditCardGroupMasterAccountIds("santander");
    if (ids.length === 0) return;
    const n = propagateCcExpenseMerchantRulesFromLegacy(ids[0]!, 15);
    expect(n).toBeGreaterThanOrEqual(0);
    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM cc_expense_merchant_categories WHERE account_id = ?`)
      .get(ids[0]!) as { c: number };
    expect(count.c).toBeGreaterThan(0);
  });

  it("restores per-line override after reimport via parser_row_id", () => {
    const accountIds = listCreditCardGroupMasterAccountIds("santander");
    const accountId = accountIds.find((id) => {
      const c = db
        .prepare(
          `SELECT COUNT(*) AS c FROM cc_statement_lines l
           JOIN cc_statements s ON s.id = l.statement_id
           WHERE s.account_id = ? AND l.parser_row_id IS NOT NULL`
        )
        .get(id) as { c: number };
      return c.c > 0;
    });
    if (!accountId) return;

    const line = db
      .prepare(
        `SELECT l.id, l.parser_row_id, l.merchant, s.statement_date, s.source_pdf, s.card_group,
                s.period_from, s.period_to
         FROM cc_statement_lines l
         JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ? AND l.parser_row_id IS NOT NULL AND l.amount_clp > 0
           AND s.period_from IS NOT NULL AND s.period_to IS NOT NULL
         LIMIT 1`
      )
      .get(accountId) as {
      id: number;
      parser_row_id: string;
      merchant: string;
      statement_date: string;
      source_pdf: string;
      card_group: string;
      period_from: string;
      period_to: string;
    } | undefined;
    if (!line) return;

    const supermarket = getCcExpenseCategoryBySlug("supermarket");
    if (!supermarket) return;

    db.prepare(
      `INSERT INTO cc_expense_line_categories (statement_line_id, category_id) VALUES (?, ?)
       ON CONFLICT(statement_line_id) DO UPDATE SET category_id = excluded.category_id`
    ).run(line.id, supermarket.id);

    const records = [
      {
        card_group: line.card_group,
        source_pdf: line.source_pdf,
        statement_date: line.statement_date,
        // Import now fails fast without the billing period (matrix month = period_to).
        period_from: line.period_from,
        period_to: line.period_to,
        card_last4: "",
        parser_layout: "compact",
        installment_flag: "false",
        amount_clp: "1000",
        merchant: line.merchant,
        transaction_date: "01/01/2025",
        row_id: line.parser_row_id,
        dedupe_key: "test-dedupe",
        raw_line: "01/01/2025 TEST $1.000",
        description_merged: "TEST",
      },
    ];

    const snap = snapshotCcExpenseCategories(accountId);
    expect(snap.lineCategoryByParserRowId.get(line.parser_row_id)).toBe(supermarket.id);

    importCcStatementsFromCsvRecords(accountId, records);

    const newLine = db
      .prepare(
        `SELECT l.id FROM cc_statement_lines l
         JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ? AND l.parser_row_id = ?`
      )
      .get(accountId, line.parser_row_id) as { id: number } | undefined;
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

  it("merchant rules on per-card accounts survive statement reimport", () => {
    const accountIds = listCreditCardGroupMasterAccountIds("santander");
    if (accountIds.length === 0) return;
    const accountId = accountIds[0]!;

    const line = db
      .prepare(
        `SELECT l.id, l.merchant FROM cc_statement_lines l
         JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ? AND l.merchant IS NOT NULL AND TRIM(l.merchant) != ''
         LIMIT 1`
      )
      .get(accountId) as { id: number; merchant: string } | undefined;
    if (!line) return;

    assignCcExpenseLineCategory({
      statementLineId: line.id,
      unique: false,
      categorySlug: "fun",
    });

    const merchantKey = normalizeCcExpenseMerchantKey(line.merchant);
    const before = loadCcExpenseCategoryMaps([accountId]).merchantRules.get(
      `${accountId}|${merchantKey}`
    );
    expect(before).toBe("fun");

    importCcStatementsFromCsvRecords(accountId, []);

    const after = loadCcExpenseCategoryMaps([accountId]).merchantRules.get(
      `${accountId}|${merchantKey}`
    );
    expect(after).toBe("fun");

    const payload = buildFlowsCreditCardExpensesPayload();
    const hit = payload.lines.find((ln) => ln.statement_line_id === line.id);
    if (hit && normalizeCcExpenseMerchantKey(hit.merchant) === merchantKey) {
      expect(hit.category_slug).toBe("fun");
    }
  });
});
