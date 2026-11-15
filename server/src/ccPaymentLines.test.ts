import { isCcPaymentMerchant, isCcTraspasoDeudaMerchant, isCcUsdDebtAbonoMerchant } from "nw-tracker-contracts";
import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { isCardDebtTransferLine, isCardPaymentLine, isDivisasAbonoPaymentLine } from "./ccPaymentLines.js";

describe("ccPaymentLines", () => {
  it("recognizes payment merchants", () => {
    expect(isCcPaymentMerchant("PAGO")).toBe(true);
    expect(isCcPaymentMerchant("MONTO CANCELADO")).toBe(true);
    expect(isCcPaymentMerchant("ABONO")).toBe(true);
    expect(isCcPaymentMerchant("JUMBO")).toBe(false);
    expect(isCcPaymentMerchant("PAGO EN LINEA PROM. CMR FALABE")).toBe(false);
    expect(isCcPaymentMerchant("PAGO EN LINEA PROM. CMR FALABELLA S.A.")).toBe(false);
  });
});

describe("stored card payment lines", () => {
  it("reads a payment and a traspaso leg from the stored kind", () => {
    expect(isCardPaymentLine({ id: 1, kind: "card_payment" })).toBe(true);
    expect(isCardPaymentLine({ id: 1, kind: "card_refund" })).toBe(false);
    expect(isCardDebtTransferLine({ id: 1, kind: "card_debt_transfer" })).toBe(true);
    expect(isCardDebtTransferLine({ id: 1, kind: "card_payment" })).toBe(false);
  });

  it("throws on a line without a kind", () => {
    expect(() => isCardPaymentLine({ id: 7, kind: null })).toThrow(/cc_statement_lines 7/);
    expect(() => isCardDebtTransferLine({ id: 7, kind: "payment" })).toThrow(/cc_statement_lines 7/);
  });

  it("tells the divisas abono among payments by its wording", () => {
    expect(isDivisasAbonoPaymentLine({ id: 1, kind: "card_payment", merchant: "ABONO DE DIVISAS" })).toBe(true);
    expect(isDivisasAbonoPaymentLine({ id: 1, kind: "card_payment", merchant: "MONTO CANCELADO" })).toBe(false);
    expect(isDivisasAbonoPaymentLine({ id: 1, kind: "card_refund", merchant: "ABONO DE DIVISAS" })).toBe(false);
  });

  it("every stored one-shot credit agrees with the payment wording the readers used to test", () => {
    const rows = db
      .prepare(`SELECT id, kind, merchant FROM cc_statement_lines WHERE installment_flag = 0 AND amount < 0`)
      .all() as { id: number; kind: string | null; merchant: string | null }[];
    expect(rows.length).toBeGreaterThan(0);
    const disagree = rows.filter(
      (r) =>
        isCardPaymentLine(r) !== (isCcPaymentMerchant(r.merchant) || isCcUsdDebtAbonoMerchant(r.merchant)) ||
        isCardDebtTransferLine(r) !== isCcTraspasoDeudaMerchant(r.merchant)
    );
    expect(disagree.map((r) => r.id)).toEqual([]);
  });
});
