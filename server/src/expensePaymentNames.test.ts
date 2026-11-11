import { describe, expect, it } from "vitest";
import { ccPaymentEvidenceKey } from "./ccPaymentMirrorEvidence.js";
import { nameExpensePaymentLines, type PaymentNameFacts, type PaymentNameLine } from "./expensePaymentNames.js";

// Synthetic cards: 9001 «Lider» (paid), 9002 «Santander» (paying), 9003 another Santander.
const PAID = 9001;
const PAYING = 9002;
const OTHER = 9003;
const cards = new Map([
  [PAID, { brand: "Lider", last4: "0001" }],
  [PAYING, { brand: "Santander", last4: "0002" }],
  [OTHER, { brand: "Santander", last4: "0003" }],
]);
const WINDOW = { daysBefore: 3, daysAfter: 5 };

let nextId = 1;
function line(p: Partial<PaymentNameLine> & { account_id: number; amount_clp: number; purchase_on: string }): PaymentNameLine {
  const id = nextId++;
  return {
    source: "cc",
    statement_line_id: id,
    purchase_key: `vitest-pay-names|${id}`,
    line_role: "purchase",
    merchant: "VITEST SHOP",
    amount_usd: null,
    primary_card_last4: null,
    ...p,
  };
}

function facts(p: Partial<PaymentNameFacts>): PaymentNameFacts {
  return { payments: [], transfers: [], cards, window: WINDOW, ...p };
}

describe("nameExpensePaymentLines", () => {
  it("names a one-shot facturado charge and the PAGO it paid on the other card", () => {
    const charge = line({ account_id: PAYING, amount_clp: 500_000, purchase_on: "2036-03-05", merchant: "RECAUDACION X" });
    const pago = line({ account_id: PAID, amount_clp: -500_000, purchase_on: "2036-03-07", merchant: "PAGO" });
    const out = nameExpensePaymentLines(
      [charge, pago],
      facts({ payments: [{ paid_account_id: PAID, facturado_clp: 500_000, plans: [], charges: [{ account_id: PAYING, line_ids: [charge.statement_line_id] }] }] })
    );
    expect(out[0]!.payment_name).toEqual({ kind: "pays_card", card_brand: "Lider", card_last4: "0001" });
    expect(out[1]!.payment_name).toEqual({ kind: "paid_by_card", card_brand: "Santander", card_last4: "0002" });
    expect(out[0]!.merchant).toBe("RECAUDACION X");
  });

  it("names a cuota plan's total and cuota lines that paid a facturado", () => {
    const key = "installment-h:vitest-pay-names-plan";
    const total = line({ account_id: PAYING, amount_clp: 900_000, purchase_on: "2036-04-28", purchase_key: key, line_role: "installment_purchase_total", statement_line_id: -77 });
    const cuota = line({ account_id: PAYING, amount_clp: 300_000, purchase_on: "2036-06-10", purchase_key: key, line_role: "installment_cuota" });
    const pago = line({ account_id: PAID, amount_clp: -900_000, purchase_on: "2036-04-27", merchant: "PAGO" });
    const out = nameExpensePaymentLines(
      [total, cuota, pago],
      facts({ payments: [{ paid_account_id: PAID, facturado_clp: 900_000, plans: [{ account_id: PAYING, purchase_key: key }], charges: [] }] })
    );
    expect(out[0]!.payment_name?.kind).toBe("pays_card");
    expect(out[1]!.payment_name?.kind).toBe("pays_card");
    expect(out[2]!.payment_name).toEqual({ kind: "paid_by_card", card_brand: "Santander", card_last4: "0002" });
  });

  it("names one PAGO per plan when a facturado paid by two plans prints two payments", () => {
    const k1 = "installment-h:vitest-pay-names-p1";
    const k2 = "installment-h:vitest-pay-names-p2";
    const t1 = line({ account_id: PAYING, amount_clp: 1_200_000, purchase_on: "2036-06-30", purchase_key: k1, line_role: "installment_purchase_total", statement_line_id: -81 });
    const t2 = line({ account_id: PAYING, amount_clp: 1_267_034, purchase_on: "2036-06-30", purchase_key: k2, line_role: "installment_purchase_total", statement_line_id: -82 });
    const p1 = line({ account_id: PAID, amount_clp: -1_200_000, purchase_on: "2036-06-30", merchant: "PAGO" });
    const p2 = line({ account_id: PAID, amount_clp: -1_267_034, purchase_on: "2036-06-30", merchant: "PAGO" });
    const stray = line({ account_id: PAID, amount_clp: -50_000, purchase_on: "2036-07-01", merchant: "PAGO" });
    const out = nameExpensePaymentLines(
      [t1, t2, p1, p2, stray],
      facts({
        payments: [
          { paid_account_id: PAID, facturado_clp: 2_467_034, plans: [{ account_id: PAYING, purchase_key: k1 }, { account_id: PAYING, purchase_key: k2 }], charges: [] },
        ],
      })
    );
    expect(out.map((l) => l.payment_name?.kind ?? null)).toEqual(["pays_card", "pays_card", "paid_by_card", "paid_by_card", null]);
  });

  it("names a peso card payment paid from checking", () => {
    const pago = line({ account_id: PAYING, amount_clp: -123_456, purchase_on: "2036-05-02", merchant: "MONTO CANCELADO" });
    const key = ccPaymentEvidenceKey({ cc_account_id: PAYING, pago_iso: "2036-05-02", currency: "clp", amount_clp: 123_456, amount_usd: null });
    const out = nameExpensePaymentLines([pago], facts({ transfers: [{ key, from_account_name: "Cuenta corriente" }] }));
    expect(out[0]!.payment_name).toEqual({ kind: "paid_from_account", account_name: "Cuenta corriente" });
  });

  it("names a dollar ABONO DE DIVISAS paid from the dollar account, by its dollars", () => {
    const abono = line({ account_id: PAYING, amount_clp: -950_000, amount_usd: -1000.5, purchase_on: "2036-05-09", merchant: "ABONO DE DIVISAS" });
    const key = ccPaymentEvidenceKey({ cc_account_id: PAYING, pago_iso: "2036-05-09", currency: "usd", amount_clp: 0, amount_usd: 1000.5 });
    const out = nameExpensePaymentLines([abono], facts({ transfers: [{ key, from_account_name: "Santander USD" }] }));
    expect(out[0]!.payment_name).toEqual({ kind: "paid_from_account", account_name: "Santander USD" });
  });

  it("leaves an unmatched PAGO unnamed", () => {
    const pago = line({ account_id: PAID, amount_clp: -42_000, purchase_on: "2036-07-01", merchant: "PAGO" });
    const charge = line({ account_id: PAYING, amount_clp: 500_000, purchase_on: "2036-03-05" });
    const out = nameExpensePaymentLines(
      [charge, pago],
      facts({ payments: [{ paid_account_id: PAID, facturado_clp: 500_000, plans: [], charges: [{ account_id: PAYING, line_ids: [charge.statement_line_id] }] }] })
    );
    expect(out[1]!.payment_name).toBeUndefined();
  });

  it("names no PAGO when two payments of the facturado sit in the window", () => {
    const charge = line({ account_id: PAYING, amount_clp: 500_000, purchase_on: "2036-03-05" });
    const a = line({ account_id: PAID, amount_clp: -500_000, purchase_on: "2036-03-04", merchant: "PAGO" });
    const b = line({ account_id: PAID, amount_clp: -500_000, purchase_on: "2036-03-08", merchant: "PAGO" });
    const out = nameExpensePaymentLines(
      [charge, a, b],
      facts({ payments: [{ paid_account_id: PAID, facturado_clp: 500_000, plans: [], charges: [{ account_id: PAYING, line_ids: [charge.statement_line_id] }] }] })
    );
    expect(out[0]!.payment_name?.kind).toBe("pays_card");
    expect(out[1]!.payment_name).toBeUndefined();
    expect(out[2]!.payment_name).toBeUndefined();
  });

  it("names copies of one payment alike, and nothing when two transfers share its identity", () => {
    const charge = line({ account_id: PAYING, amount_clp: 500_000, purchase_on: "2036-03-05" });
    const planted = line({ account_id: PAID, amount_clp: -500_000, purchase_on: "2036-03-06", merchant: "PAGO" });
    const statement = line({ account_id: PAID, amount_clp: -500_000, purchase_on: "2036-03-06", merchant: "MONTO CANCELADO" });
    const pago = line({ account_id: OTHER, amount_clp: -10_000, purchase_on: "2036-03-06", merchant: "PAGO" });
    const key = ccPaymentEvidenceKey({ cc_account_id: OTHER, pago_iso: "2036-03-06", currency: "clp", amount_clp: 10_000, amount_usd: null });
    const out = nameExpensePaymentLines(
      [charge, planted, statement, pago],
      facts({
        payments: [{ paid_account_id: PAID, facturado_clp: 500_000, plans: [], charges: [{ account_id: PAYING, line_ids: [charge.statement_line_id] }] }],
        transfers: [
          { key, from_account_name: "Cuenta corriente" },
          { key, from_account_name: "Cuenta vista" },
        ],
      })
    );
    expect(out[1]!.payment_name?.kind).toBe("paid_by_card");
    expect(out[2]!.payment_name?.kind).toBe("paid_by_card");
    expect(out[3]!.payment_name).toBeUndefined();
  });
});
