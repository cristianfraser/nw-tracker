import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { importCcStatementsMerge } from "./ccStatementsImport.js";
import { getVitestSantanderCcMasterAccountId } from "./test/vitestDbSeed.js";
/** Reserved web-paste keys for this file only; cleaned up so a failed run does not pollute dev DB. */
const SRC_DEDUPE = "import:web-paste|vitest-cc-merge-dedupe";
const SRC_OVERLAP = "import:web-paste|vitest-cc-merge-overlap";

function cleanupVitestCcMergeRows(): void {
  db.prepare(
    `DELETE FROM cc_statement_lines WHERE statement_id IN (
       SELECT id FROM cc_statements WHERE source_pdf IN (?, ?)
     )`
  ).run(SRC_DEDUPE, SRC_OVERLAP);
  db.prepare(`DELETE FROM cc_statements WHERE source_pdf IN (?, ?)`).run(SRC_DEDUPE, SRC_OVERLAP);
  /** Legacy keys from an older version of this test. */
  db.prepare(
    `DELETE FROM cc_statement_lines WHERE statement_id IN (
       SELECT id FROM cc_statements WHERE source_pdf IN ('import:web-paste|test-dedupe', 'import:web-paste|test-overlap')
     )`
  ).run();
  db.prepare(
    `DELETE FROM cc_statements WHERE source_pdf IN ('import:web-paste|test-dedupe', 'import:web-paste|test-overlap')`
  ).run();
}

describe("importCcStatementsMerge", () => {
  afterEach(() => {
    cleanupVitestCcMergeRows();
    db.prepare(
      `DELETE FROM cc_installment_purchases
       WHERE card_group = 'santander' AND canonical_row_id = 'vitest-cc-merge-overlap-canonical'`
    ).run();
  });

  it("skips duplicate dedupe_key on second import", () => {
    const accountId = getVitestSantanderCcMasterAccountId();
    if (accountId == null) return;

    const dedupeKey = `vitest-dedupe-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const records = [
      {
        card_group: "santander",
        source_pdf: SRC_DEDUPE,
        statement_date: "20/05/2026",
        period_from: "01/05/2026",
        period_to: "19/05/2026",
        card_last4: "0000",
        transaction_date: "19/05/2026",
        merchant: "Merge dedupe fixture row",
        amount_clp: "12345",
        installment_flag: "false",
        dedupe_key: dedupeKey,
        row_id: `t1-${dedupeKey}`,
        currency: "clp",
        parser_layout: "compact",
      },
    ];

    try {
      const first = importCcStatementsMerge(accountId, records, { replaceAll: false });
      expect(first.linesInserted).toBe(1);

      const second = importCcStatementsMerge(accountId, records, { replaceAll: false });
      expect(second.linesInserted).toBe(0);
      expect(second.linesSkippedDuplicate).toBe(1);
    } finally {
      cleanupVitestCcMergeRows();
    }
  });

  it("skips one-shot line when matching installment purchase exists", () => {
    const accountId = getVitestSantanderCcMasterAccountId();
    if (accountId == null) return;

    let purchaseId = 0;
    try {
      const purchase = db
        .prepare(
          `INSERT INTO cc_installment_purchases (
             account_id, card_group, canonical_row_id, purchase_date, total_amount_clp,
             cuotas_totales, merchant, source
           ) VALUES (?, 'santander', 'vitest-cc-merge-overlap-canonical', '2026-05-19', 492000, 12, 'Overlap fixture merchant', 'manual')`
        )
        .run(accountId);
      purchaseId = Number(purchase.lastInsertRowid);

      const records = [
        {
          card_group: "santander",
          source_pdf: SRC_OVERLAP,
          statement_date: "20/05/2026",
          period_from: "01/05/2026",
          period_to: "19/05/2026",
          card_last4: "0000",
          transaction_date: "19/05/2026",
          merchant: "Overlap fixture merchant",
          amount_clp: "492000",
          installment_flag: "false",
          dedupe_key: `vitest-overlap-${randomUUID().replace(/-/g, "").slice(0, 16)}`,
          row_id: "t-overlap",
          currency: "clp",
          parser_layout: "compact",
        },
      ];

      const r = importCcStatementsMerge(accountId, records, { replaceAll: false });
      expect(r.linesInserted).toBe(0);
      expect(r.linesSkippedInstallmentOverlap).toBe(1);
    } finally {
      if (purchaseId > 0) {
        db.prepare(`DELETE FROM cc_installment_purchases WHERE id = ?`).run(purchaseId);
      }
      cleanupVitestCcMergeRows();
    }
  });
});
