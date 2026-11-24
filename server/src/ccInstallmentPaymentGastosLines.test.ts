import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { normalizeCcExpenseMerchantKey } from "./ccExpenseCategories.js";
import { buildInstallmentPaymentGastosLines, installmentPaymentGastosLineId } from "./ccInstallmentPaymentGastosLines.js";
import type { FlowCcExpenseLineRowDraft } from "./expenseLineTypes.js";
import { createTempCardMaster, deleteTempCardMaster } from "./test/tempCardMaster.js";

describe("ccInstallmentPaymentGastosLines", () => {
  let accountId = 0;
  const paymentIds: number[] = [];

  beforeEach(() => {
    accountId = createTempCardMaster({ issuer: "santander", last4: "4242", key: "vitest-payment-gastos" });
    const purchaseId = Number(
      db
        .prepare(
          `INSERT INTO cc_installment_purchases (
             account_id, card_group, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales, merchant, source
           ) VALUES (?, 'santander', 'vitest-payment-gastos', '2026-03-10', 300000, 3, 'ACME STORE', 'pdf')`
        )
        .run(accountId).lastInsertRowid
    );
    const insPayment = db.prepare(
      `INSERT INTO cc_installment_payments (
         purchase_id, pay_by_date, amount_clp, cuota_current, cuota_total, statement_period_month
       ) VALUES (?, ?, 100000, ?, 3, ?)`
    );
    paymentIds.length = 0;
    for (const [n, payBy, month] of [
      [1, "2026-05-08", "2026-04"],
      [2, "2026-06-10", "2026-05"],
      [3, "2026-07-10", "2026-06"],
    ] as const) {
      paymentIds.push(Number(insPayment.run(purchaseId, payBy, n, month).lastInsertRowid));
    }
  });

  afterEach(() => {
    deleteTempCardMaster(accountId);
  });

  it("adds cuota lines from installment ledger when statement lines are sparse", () => {
    // The statements on file print only cuota 1; cuotas 2 and 3 come from the plan's payments.
    const printedCuota1 = {
      source: "cc",
      statement_line_id: 1,
      account_id: accountId,
      line_role: "installment_cuota",
      purchase_on: "2026-03-10",
      nro_cuota_current: 1,
      merchant: "ACME STORE",
      merchant_key: normalizeCcExpenseMerchantKey("ACME STORE"),
      amount_clp: 100000,
    } as FlowCcExpenseLineRowDraft;

    const lines = buildInstallmentPaymentGastosLines([accountId], [printedCuota1]);
    expect(
      lines.map((ln) => ({
        id: ln.statement_line_id,
        role: ln.line_role,
        cuota: ln.nro_cuota_current,
        billing_month: ln.billing_month,
        occurred_on: ln.occurred_on,
        amount_clp: ln.amount_clp,
        total: ln.installment_total_clp,
      }))
    ).toEqual([
      {
        id: installmentPaymentGastosLineId(paymentIds[1]!),
        role: "installment_cuota",
        cuota: 2,
        billing_month: "2026-05",
        occurred_on: "2026-06-10",
        amount_clp: 100000,
        total: 300000,
      },
      {
        id: installmentPaymentGastosLineId(paymentIds[2]!),
        role: "installment_cuota",
        cuota: 3,
        billing_month: "2026-06",
        occurred_on: "2026-07-10",
        amount_clp: 100000,
        total: 300000,
      },
    ]);
    // Without any statement line every cuota comes from the ledger.
    expect(buildInstallmentPaymentGastosLines([accountId], []).map((ln) => ln.nro_cuota_current)).toEqual([1, 2, 3]);
  });

  it("keeps ledger line ids clear of statement line ids", () => {
    expect(installmentPaymentGastosLineId(1)).toBe(-2_000_000_001);
  });
});
