import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { mergeInstallmentLedgerFromParsedRows } from "./ccInstallmentLedgerMerge.js";
import { ccInstallmentsDbApiPayload } from "./ccInstallmentLedgerDb.js";
import type { CcStatementCsvRecord } from "./ccStatementsImport.js";
import { getVitestSantanderCcMasterAccountId } from "./test/vitestDbSeed.js";

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
    const masterId = getVitestSantanderCcMasterAccountId();
    expect(masterId).not.toBeNull();
    if (masterId == null) return;
    const master = { id: masterId };

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

  it("stores a 00/N row with no cuota number, so it bills nothing (statement JSON writes 0, 2026-10-28)", () => {
    const masterId = getVitestSantanderCcMasterAccountId();
    if (masterId == null) throw new Error("vitest card master missing");
    // Bought in the cycle the statement closes: the statement prints 00/3, cuota 1 bills next cycle.
    const rows = [
      {
        card_group: "A",
        installment_flag: "true",
        transaction_date: "05/10/2096",
        amount_clp: "300000",
        nro_cuota_current: "0",
        nro_cuota_total: "3",
        merchant: "VITEST MERGE CUOTA CERO",
        valor_cuota_mensual_clp: "100000",
        pay_by: "10/11/2096",
        statement_date: "26/10/2096",
        period_to: "26/10/2096",
        source_pdf: "import:santander-json|clp|26/10/2096",
        canonical_row_id: "canon-cuota-cero",
        row_id: "row-cuota-cero",
      },
    ] as CcStatementCsvRecord[];
    mergeInstallmentLedgerFromParsedRows(masterId, rows);
    const purchase = db
      .prepare(`SELECT id FROM cc_installment_purchases WHERE account_id = ? AND merchant = 'VITEST MERGE CUOTA CERO'`)
      .get(masterId) as { id: number };
    purchaseIds.push(purchase.id);
    const pays = db
      .prepare(`SELECT id, cuota_current FROM cc_installment_payments WHERE purchase_id = ?`)
      .all(purchase.id) as { id: number; cuota_current: number | null }[];
    expect(pays.map((p) => p.cuota_current)).toEqual([null]);

    const plan = ccInstallmentsDbApiPayload(masterId).purchases.find((p) => p.purchase_db_id === purchase.id)!;
    expect(plan.installments_paid).toBe(0);
    expect(plan.remaining_principal_clp).toBe(300_000);
    expect(plan.cuota_progress?.cuotas.map((c) => c.status)).toEqual(["pending", "pending", "pending"]);

    // A stored cuota 0 is bad data: the ledger refuses it instead of counting it as cuota 1.
    db.prepare(`UPDATE cc_installment_payments SET cuota_current = 0 WHERE id = ?`).run(pays[0]!.id);
    expect(() => ccInstallmentsDbApiPayload(masterId)).toThrow(/stores cuota 0/);
  });
});
