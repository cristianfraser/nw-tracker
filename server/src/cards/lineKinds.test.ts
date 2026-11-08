import { cardLineKind, type CardLineKindInput } from "nw-tracker-contracts";
import { describe, expect, it } from "vitest";
import { requireStoredCardLineKind } from "./lineKinds.js";

const clp = (merchant: string, amount: number, extra: Partial<CardLineKindInput> = {}): CardLineKindInput => ({
  installment_flag: 0,
  merchant,
  amount_clp: amount,
  amount_usd: null,
  statement_currency: "clp",
  ...extra,
});
const usd = (merchant: string, amount: number): CardLineKindInput => ({
  installment_flag: 0,
  merchant,
  amount_clp: null,
  amount_usd: amount,
  statement_currency: "usd",
});

describe("cardLineKind", () => {
  it.each([
    ["a purchase", clp("SUPERMERCADO", 12_000), "card_purchase"],
    ["a cuota line, whatever its wording", clp("PAGO", 5_000, { installment_flag: 1 }), "installment_cuota"],
    ["a payment", clp("PAGO", -50_000), "card_payment"],
    ["a payment printed as MONTO CANCELADO", clp("MONTO CANCELADO", -50_000), "card_payment"],
    ["a dollar payment (ABONO DE DIVISAS)", usd("ABONO DE DIVISAS", -120), "card_payment"],
    ["a traspaso de deuda leg", usd("TRASPASO A DEUDA NACIONAL", -80), "card_debt_transfer"],
    ["the peso leg of a traspaso", clp("TRASPASO DE DEUDA INTERNACIONAL", 76_000), "card_debt_transfer"],
    ["a merchant refund", clp("TIENDA", -9_990), "card_refund"],
    ["a nota de crédito", clp("NOTA DE CREDITO", -9_990), "card_refund"],
    ["interest", clp("INTERESES ROTATIVOS", 1_234), "financing_charge"],
    ["a stamp tax", clp("IMPTO. DECRETO LEY 3475", 79), "financing_charge"],
    ["a dollar fee", usd("COMISION", 2.5), "financing_charge"],
    ["a dollar purchase", usd("APPLE.COM/BILL", 13.22), "card_purchase"],
    ["a dollar credit that is no payment", usd("APPLE.COM/BILL", -13.22), "card_refund"],
    ["a zero line", clp("TIENDA", 0), "card_purchase"],
  ] as const)("%s", (_label, line, kind) => {
    expect(cardLineKind(line)).toBe(kind);
  });

  it("reads the dollars on a dollar statement and the pesos on a peso statement", () => {
    // A peso statement's line with both amounts: the pesos decide (the dollar rule is not asked).
    expect(cardLineKind(clp("SERVICIO USO INTERNACIONAL", 900, { amount_usd: 1 }))).toBe("financing_charge");
    expect(cardLineKind({ ...usd("COMPRA", 10), amount_clp: -9_000 })).toBe("card_purchase");
  });

  it("refuses a stored value that is not a card line kind", () => {
    expect(requireStoredCardLineKind("card_refund", 1)).toBe("card_refund");
    expect(() => requireStoredCardLineKind(null, 7)).toThrow(/cc_statement_lines 7/);
    expect(() => requireStoredCardLineKind("purchase", 7)).toThrow(/not a card line kind/);
  });
});
