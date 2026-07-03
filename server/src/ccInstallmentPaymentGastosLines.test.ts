import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { buildFlowsCreditCardExpensesPayload } from "./flowsCreditCardExpenses.js";
import {
  buildInstallmentPaymentGastosLines,
  installmentPaymentGastosLineId,
} from "./ccInstallmentPaymentGastosLines.js";
import { normalizeCcExpenseMerchantKey } from "./ccExpenseCategories.js";
import type { FlowCcExpenseLineRowDraft } from "./flowsCreditCardExpenses.js";

describe("ccInstallmentPaymentGastosLines", () => {
  it("does not duplicate cuotas already present on statement PDF lines", () => {
    const payload = buildFlowsCreditCardExpensesPayload();
    const serviteca = payload.lines.filter((ln) => (ln.merchant ?? "").includes("SERVITECA DACSA"));
    const cuotas = serviteca.filter((ln) => ln.line_role === "installment_cuota");
    if (cuotas.length === 0) return;

    const byCuota = new Map<string, number>();
    for (const ln of cuotas) {
      const key = `${ln.purchase_on}:${ln.nro_cuota_current}/${ln.nro_cuota_total}`;
      byCuota.set(key, (byCuota.get(key) ?? 0) + 1);
    }
    for (const [key, count] of byCuota) {
      expect(count, key).toBe(1);
    }
    expect(cuotas).toHaveLength(3);
  });

  it("skips ledger cuota when the same cuota already exists on any statement PDF line", () => {
    const id4242 = (
      db.prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`).get() as
        | { id: number }
        | undefined
    )?.id;
    if (!id4242) return;

    const pay = db
      .prepare(
        `SELECT p.id, p.pay_by_date, p.statement_date, p.cuota_current, p.amount_clp, pr.purchase_date, pr.merchant
         FROM cc_installment_payments p
         JOIN cc_installment_purchases pr ON pr.id = p.purchase_id
         WHERE pr.account_id = ? AND p.statement_date LIKE '%/04/2026'
           AND p.cuota_current IS NOT NULL AND p.amount_clp > 0
         LIMIT 1`
      )
      .get(id4242) as
      | {
          id: number;
          pay_by_date: string;
          statement_date: string | null;
          cuota_current: number;
          amount_clp: number;
          purchase_date: string;
          merchant: string | null;
        }
      | undefined;
    if (!pay) return;

    const purchaseOn = pay.purchase_date.slice(0, 10);
    const aprilPdfLine: FlowCcExpenseLineRowDraft = {
      source: "cc",
      statement_line_id: 9_990_001,
      account_id: id4242,
      expense_month: "2026-04",
      billing_month: "2026-04",
      purchase_month: purchaseOn.slice(0, 7),
      line_role: "installment_cuota",
      occurred_on: "2026-04-22",
      purchase_on: purchaseOn,
      statement_date: pay.statement_date ?? "22/04/2026",
      amount_clp: pay.amount_clp,
      amount_usd: null,
      merchant: pay.merchant,
      installment_flag: 1,
      nro_cuota_current: pay.cuota_current,
      nro_cuota_total: 12,
      merchant_key: normalizeCcExpenseMerchantKey(pay.merchant),
      category_slug: "unclassified",
      category_unique: false,
      amount_usd_at_expense: null,
      origin_card_last4: null,
      primary_card_last4: null,
    };

    const fromLedger = buildInstallmentPaymentGastosLines([id4242], [aprilPdfLine]);
    const dup = fromLedger.find(
      (ln) =>
        ln.purchase_on === purchaseOn &&
        ln.nro_cuota_current === pay.cuota_current &&
        ln.amount_clp === pay.amount_clp
    );
    expect(dup).toBeUndefined();
  });

  it("adds 4242 cuota lines from installment ledger when statement lines are sparse", () => {
    const id4242 = (
      db.prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`).get() as
        | { id: number }
        | undefined
    )?.id;
    if (!id4242) return;

    const stmtLines = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM cc_statement_lines l
           JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ?`
        )
        .get(id4242) as { c: number }
    ).c;
    const payLines = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM cc_installment_payments p
           JOIN cc_installment_purchases pr ON pr.id = p.purchase_id
           WHERE pr.account_id = ?`
        )
        .get(id4242) as { c: number }
    ).c;
    if (payLines === 0) return;

    const payload = buildFlowsCreditCardExpensesPayload();
    const cuotas4242 = payload.lines.filter(
      (ln) =>
        ln.source === "cc" &&
        ln.account_id === id4242 &&
        ln.line_role === "installment_cuota" &&
        ln.amount_clp > 0
    );
    const fromLedger = cuotas4242.filter((ln) => ln.statement_line_id < -1_000_000_000);

    if (stmtLines < 10) {
      expect(fromLedger.length).toBeGreaterThan(0);
    }
    expect(cuotas4242.length).toBeGreaterThan(0);
    expect(installmentPaymentGastosLineId(1)).toBeLessThan(-1_000_000_000);
  });
});
