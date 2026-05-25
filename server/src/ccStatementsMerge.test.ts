import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { importCcStatementsMerge } from "./ccStatementsImport.js";

describe("importCcStatementsMerge", () => {
  it("skips duplicate dedupe_key on second import", () => {
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN categories c ON c.id = a.category_id
         WHERE c.slug = 'credit_card' AND a.notes LIKE 'credit_card_master|santander|%'
         LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;

    const records = [
      {
        card_group: "santander",
        source_pdf: "import:web-paste|test-dedupe",
        statement_date: "20/05/2026",
        card_last4: "4242",
        transaction_date: "19/05/2026",
        merchant: "TEST MERGE DEDUPE",
        amount_clp: "12345",
        installment_flag: "false",
        dedupe_key: "testmerge0012345ab",
        row_id: "t1",
        currency: "clp",
        parser_layout: "compact",
      },
    ];

    const first = importCcStatementsMerge(row.id, records, { replaceAll: false });
    expect(first.linesInserted).toBe(1);

    const second = importCcStatementsMerge(row.id, records, { replaceAll: false });
    expect(second.linesInserted).toBe(0);
    expect(second.linesSkippedDuplicate).toBe(1);

    db.prepare(
      `DELETE FROM cc_statement_lines WHERE statement_id IN (
        SELECT id FROM cc_statements WHERE account_id = ? AND source_pdf = ?
      )`
    ).run(row.id, "import:web-paste|test-dedupe");
    db.prepare(`DELETE FROM cc_statements WHERE account_id = ? AND source_pdf = ?`).run(
      row.id,
      "import:web-paste|test-dedupe"
    );
  });

  it("skips one-shot line when matching installment purchase exists", () => {
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN categories c ON c.id = a.category_id
         WHERE c.slug = 'credit_card' AND a.notes LIKE 'credit_card_master|santander|%'
         LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;

    const purchase = db
      .prepare(
        `INSERT INTO cc_installment_purchases (
           account_id, card_group, canonical_row_id, purchase_date, total_amount_clp,
           cuotas_totales, merchant, source
         ) VALUES (?, 'santander', 'test-overlap-canonical', '2026-05-19', 492000, 12, 'OVERLAP TEST MERCHANT', 'manual')`
      )
      .run(row.id);
    const purchaseId = Number(purchase.lastInsertRowid);

    const records = [
      {
        card_group: "santander",
        source_pdf: "import:web-paste|test-overlap",
        statement_date: "20/05/2026",
        card_last4: "4242",
        transaction_date: "19/05/2026",
        merchant: "OVERLAP TEST MERCHANT",
        amount_clp: "492000",
        installment_flag: "false",
        dedupe_key: "testoverlap492000",
        row_id: "t-overlap",
        currency: "clp",
        parser_layout: "compact",
      },
    ];

    const r = importCcStatementsMerge(row.id, records, { replaceAll: false });
    expect(r.linesInserted).toBe(0);
    expect(r.linesSkippedInstallmentOverlap).toBe(1);

    db.prepare(`DELETE FROM cc_installment_purchases WHERE id = ?`).run(purchaseId);
    db.prepare(`DELETE FROM cc_statements WHERE account_id = ? AND source_pdf = ?`).run(
      row.id,
      "import:web-paste|test-overlap"
    );
  });
});
