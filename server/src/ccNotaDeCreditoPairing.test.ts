import { describe, expect, it } from "vitest";
import {
  enrichLinesWithNotaDeCreditoPairing,
  isNotaDeCreditoMerchant,
  NOTA_DE_CREDITO_MATCH_MIN_CLP,
  pairNotaDeCreditoAnnulments,
} from "./ccNotaDeCreditoPairing.js";
import type { FlowCcExpenseLineRow } from "./flowsCreditCardExpenses.js";

function ccLine(
  overrides: Partial<FlowCcExpenseLineRow> & Pick<FlowCcExpenseLineRow, "statement_line_id" | "amount_clp">
): FlowCcExpenseLineRow {
  return {
    source: "cc",
    account_id: 1,
    expense_month: "2024-11",
    billing_month: "2024-11",
    purchase_month: "2024-11",
    line_role: "purchase",
    occurred_on: "2024-11-22",
    purchase_on: "2024-11-12",
    statement_date: "22/11/2024",
    merchant: "APPLE.COM CL",
    merchant_key: "apple",
    category_slug: "shopping",
    category_unique: false,
    installment_flag: 0,
    nro_cuota_current: null,
    nro_cuota_total: null,
    ...overrides,
  };
}

describe("isNotaDeCreditoMerchant", () => {
  it("matches NOTA DE CREDITO variants", () => {
    expect(isNotaDeCreditoMerchant("NOTA DE CREDITO")).toBe(true);
    expect(isNotaDeCreditoMerchant("NOTA DE CREDITO MONTO US$")).toBe(true);
    expect(isNotaDeCreditoMerchant("MONTO CANCELADO")).toBe(false);
  });
});

describe("pairNotaDeCreditoAnnulments", () => {
  it("pairs a large NOTA DE CREDITO with the most recent prior purchase of the same amount", () => {
    const purchase = ccLine({
      statement_line_id: 100,
      amount_clp: 180_990,
      purchase_on: "2024-11-12",
      expense_month: "2024-11",
    });
    const olderSameAmount = ccLine({
      statement_line_id: 99,
      amount_clp: 180_990,
      purchase_on: "2024-10-05",
      expense_month: "2024-10",
    });
    const nota = ccLine({
      statement_line_id: 200,
      amount_clp: -180_990,
      merchant: "NOTA DE CREDITO",
      purchase_on: "2024-12-14",
      expense_month: "2024-12",
    });

    const pairing = pairNotaDeCreditoAnnulments([olderSameAmount, purchase, nota]);
    expect([...pairing.annulledPurchaseIds]).toEqual([100]);
    expect([...pairing.matchedNotaIds]).toEqual([200]);
    expect(pairing.unmatchedNotaIds.size).toBe(0);
  });

  it("treats small NOTA DE CREDITO as unmatched adjustments", () => {
    const nota = ccLine({
      statement_line_id: 300,
      amount_clp: -NOTA_DE_CREDITO_MATCH_MIN_CLP + 1,
      merchant: "NOTA DE CREDITO",
      purchase_on: "2025-03-10",
      expense_month: "2025-03",
    });
  const purchase = ccLine({
      statement_line_id: 301,
      amount_clp: NOTA_DE_CREDITO_MATCH_MIN_CLP - 1,
      purchase_on: "2025-02-01",
      expense_month: "2025-02",
    });

    const pairing = pairNotaDeCreditoAnnulments([purchase, nota]);
    expect(pairing.unmatchedNotaIds.has(300)).toBe(true);
    expect(pairing.annulledPurchaseIds.size).toBe(0);
  });

  it("annotates lines with nota_credito_role", () => {
    const lines = enrichLinesWithNotaDeCreditoPairing([
      ccLine({ statement_line_id: 1, amount_clp: 54_990 }),
      ccLine({
        statement_line_id: 2,
        amount_clp: -54_990,
        merchant: "NOTA DE CREDITO",
        purchase_on: "2025-02-07",
        expense_month: "2025-02",
      }),
    ]);
    expect(lines.find((ln) => ln.statement_line_id === 1)?.nota_credito_role).toBe(
      "annulled_purchase"
    );
    expect(lines.find((ln) => ln.statement_line_id === 2)?.nota_credito_role).toBe("matched_nota");
  });
});
