import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { buildFlowsCreditCardExpensesPayload } from "./flowsCreditCardExpenses.js";
import { installmentPaymentGastosLineId } from "./ccInstallmentPaymentGastosLines.js";

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
