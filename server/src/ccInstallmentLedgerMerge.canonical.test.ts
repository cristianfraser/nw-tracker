import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { mergeInstallmentLedgerFromParsedRows } from "./ccInstallmentLedgerMerge.js";
import type { CcStatementCsvRecord } from "./ccStatementsImport.js";

describe("mergeInstallmentLedgerFromParsedRows canonical fingerprint", () => {
  const purchaseIds: number[] = [];

  afterEach(() => {
    if (purchaseIds.length === 0) return;
    const ph = purchaseIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM cc_installment_payments WHERE purchase_id IN (${ph})`).run(...purchaseIds);
    db.prepare(`DELETE FROM cc_installment_purchases WHERE id IN (${ph})`).run(...purchaseIds);
    purchaseIds.length = 0;
  });

  it("reuses one purchase when canonical_row_id differs but contract fingerprint matches", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|vitest-fixture' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const base: Partial<CcStatementCsvRecord> = {
      card_group: "A",
      installment_flag: "true",
      transaction_date: "26/02/2025",
      amount_clp: "120000",
      nro_cuota_total: "3",
      merchant: "VITEST MERGE CANON",
      valor_cuota_mensual_clp: "40000",
      pay_by: "25/03/2025",
      statement_date: "24/03/2025",
      period_to: "25/03/2025",
      source_pdf: "vitest-merge-a.pdf",
      nro_cuota_current: "1",
    };

    const rows = [
      { ...base, canonical_row_id: "canon-a", row_id: "row-a" },
      {
        ...base,
        canonical_row_id: "canon-b",
        row_id: "row-b",
        statement_date: "24/04/2025",
        period_to: "25/04/2025",
        source_pdf: "vitest-merge-b.pdf",
        nro_cuota_current: "2",
        pay_by: "25/04/2025",
      },
    ] as CcStatementCsvRecord[];

    mergeInstallmentLedgerFromParsedRows(master.id, rows);
    const purchases = db
      .prepare(
        `SELECT id FROM cc_installment_purchases
         WHERE account_id = ? AND merchant LIKE 'VITEST MERGE CANON%'`
      )
      .all(master.id) as { id: number }[];
    purchaseIds.push(...purchases.map((p) => p.id));
    expect(purchases).toHaveLength(1);
    const pays = db
      .prepare(`SELECT cuota_current FROM cc_installment_payments WHERE purchase_id = ? ORDER BY cuota_current`)
      .all(purchases[0]!.id) as { cuota_current: number | null }[];
    expect(pays.map((p) => p.cuota_current)).toEqual([1, 2]);
  });
});
