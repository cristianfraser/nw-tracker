import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { backfillAdditionalCardNoCuenta } from "./backfillAdditionalCardNoCuenta.js";
import { AUTO_ADDITIONAL_CARD_NOTE_PREFIX } from "./ccAdditionalCardExpenseMatch.js";
import {
  NO_CUENTA_CC_EXPENSE_SLUG,
  getCcExpenseCategoryBySlug,
  resolveCcExpensePurchaseKey,
} from "./ccExpenseCategories.js";
import { db } from "./db.js";
import { getVitestSantanderCcMasterAccountId } from "./test/vitestDbSeed.js";

const SRC = "import:web-paste|vitest-additional-card-backfill";

function cleanup(): void {
  db.prepare(
    `DELETE FROM cc_statement_lines WHERE statement_id IN (
       SELECT id FROM cc_statements WHERE source_pdf = ?
     )`
  ).run(SRC);
  db.prepare(`DELETE FROM cc_statements WHERE source_pdf = ?`).run(SRC);
}

describe("backfillAdditionalCardNoCuenta", () => {
  afterEach(() => cleanup());

  it("UPSERTs no_cuenta unique purchase and auto note for adicional lines", () => {
    const accountId = getVitestSantanderCcMasterAccountId();
    if (accountId == null) return;

    const parserRowId = `vitest-addl-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const stmt = db
      .prepare(
        `INSERT INTO cc_statements (
           account_id, card_group, source_pdf, statement_date, period_from, period_to,
           card_last4, layout, currency
         ) VALUES (?, 'santander', ?, '20/05/2026', '01/05/2026', '19/05/2026', '4242', 'compact', 'clp')`
      )
      .run(accountId, SRC);
    const statementId = Number(stmt.lastInsertRowid);
    const line = db
      .prepare(
        `INSERT INTO cc_statement_lines (
           statement_id, transaction_date, merchant, amount_clp, installment_flag,
           parser_row_id, origin_card_last4
         ) VALUES (?, '19/05/2026', 'Additional card fixture', 9999, 0, ?, '3670')`
      )
      .run(statementId, parserRowId);
    const lineId = Number(line.lastInsertRowid);
    const purchaseKey = resolveCcExpensePurchaseKey(lineId);
    const noCuentaId = getCcExpenseCategoryBySlug(NO_CUENTA_CC_EXPENSE_SLUG)?.id;

    const result = backfillAdditionalCardNoCuenta();
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.updated).toBeGreaterThanOrEqual(1);

    const unique = db
      .prepare(
        `SELECT category_id FROM cc_expense_unique_purchases
         WHERE account_id = ? AND purchase_key = ?`
      )
      .get(accountId, purchaseKey) as { category_id: number } | undefined;
    expect(unique?.category_id).toBe(noCuentaId);

    const note = db
      .prepare(
        `SELECT notes FROM cc_expense_purchase_notes WHERE account_id = ? AND purchase_key = ?`
      )
      .get(accountId, purchaseKey) as { notes: string } | undefined;
    expect(note?.notes.startsWith(AUTO_ADDITIONAL_CARD_NOTE_PREFIX)).toBe(true);
  });
});
