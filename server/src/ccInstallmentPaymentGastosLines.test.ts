import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { buildFlowsExpensesPayload } from "./flowsExpenses.js";
import { installmentPaymentGastosLineId } from "./ccInstallmentPaymentGastosLines.js";

describe("ccInstallmentPaymentGastosLines", () => {
  it("adds cuota lines from installment ledger when statement lines are sparse", () => {
    const cardId = (
      db.prepare(`SELECT id FROM accounts WHERE import_key = 'credit_card_master|santander|4321'`).get() as
        | { id: number }
        | undefined
    )?.id;
    if (!cardId) return;

    const stmtLines = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM cc_statement_lines l
           JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ?`
        )
        .get(cardId) as { c: number }
    ).c;
    const payLines = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM cc_installment_payments p
           JOIN cc_installment_purchases pr ON pr.id = p.purchase_id
           WHERE pr.account_id = ?`
        )
        .get(cardId) as { c: number }
    ).c;
    if (payLines === 0) return;

    const payload = buildFlowsExpensesPayload();
    const cardCuotas = payload.lines.filter(
      (ln) =>
        ln.source === "cc" &&
        ln.account_id === cardId &&
        ln.line_role === "installment_cuota" &&
        ln.amount_clp > 0
    );
    const fromLedger = cardCuotas.filter((ln) => ln.statement_line_id < -1_000_000_000);

    if (stmtLines < 10) {
      expect(fromLedger.length).toBeGreaterThan(0);
    }
    expect(cardCuotas.length).toBeGreaterThan(0);
    expect(installmentPaymentGastosLineId(1)).toBeLessThan(-1_000_000_000);
  });
});
