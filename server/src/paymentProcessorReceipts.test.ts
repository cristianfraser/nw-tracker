import { describe, expect, it } from "vitest";
import { matchPaymentReceipts, type ReceiptCandidateLine, type StoredPaymentReceipt } from "./paymentProcessorReceipts.js";

const receipt = (id: string, paidAt: string, amount: number, processor = "flow"): StoredPaymentReceipt => ({
  message_id: id,
  processor,
  payee: `payee ${id}`,
  payee_rut: null,
  payee_email: null,
  concept: null,
  order_ref: null,
  paid_at_chile: paidAt,
  statement_descriptor: null,
  installments: null,
  amount,
  currency: "clp",
});
const line = (key: string, on: string, amount: number, merchant: string, extra: Partial<ReceiptCandidateLine> = {}): ReceiptCandidateLine => ({
  source: "cc",
  purchase_key: key,
  amount_clp: amount,
  purchase_on: on,
  merchant,
  line_role: "purchase",
  ...extra,
});

describe("matchPaymentReceipts", () => {
  it("pairs by pesos inside the day window, nearest day first", () => {
    const { byPurchaseKey, unpaired } = matchPaymentReceipts(
      [receipt("a", "2036-09-02 17:09", 125716), receipt("b", "2036-10-01 10:00", 999)],
      [line("k1", "2036-09-02", 125716, "PAGOS.FLOW.CL (WEB)"), line("k2", "2036-09-09", 125716, "PAGOS.FLOW.CL (WEB)"), line("k3", "2036-09-30", 999, "X")]
    );
    expect(byPurchaseKey.get("k1")?.message_id).toBe("a");
    expect(byPurchaseKey.has("k2")).toBe(false);
    expect(byPurchaseKey.get("k3")?.message_id).toBe("b"); // the day before (a mail after midnight)
    expect(unpaired).toEqual({});
  });

  it("pairs identical payments in order and prefers the processor's merchant on a same-day tie", () => {
    const { byPurchaseKey, ambiguous } = matchPaymentReceipts(
      [receipt("a", "2036-04-01 10:00", 200000), receipt("b", "2036-04-01 11:00", 200000), receipt("c", "2036-05-01 10:00", 5000)],
      [
        line("k1", "2036-04-01", 200000, "FLOW*TIENDA.CL"),
        line("k2", "2036-04-01", 200000, "FLOW*TIENDA.CL"),
        line("k3", "2036-05-01", 5000, "SUPERMERCADO"),
        line("k4", "2036-05-01", 5000, "PAGOS.FLOW.CL (WEB)"),
      ]
    );
    expect(ambiguous).toEqual([]);
    expect([byPurchaseKey.get("k1")?.message_id, byPurchaseKey.get("k2")?.message_id].sort()).toEqual(["a", "b"]);
    expect(byPurchaseKey.get("k4")?.message_id).toBe("c");
  });

  it("leaves a tie it cannot break unpaired, and never pairs a cuota line or a credit", () => {
    const { byPurchaseKey, unpaired, ambiguous } = matchPaymentReceipts(
      [receipt("a", "2036-04-01 10:00", 1000), receipt("b", "2036-06-01 10:00", 3000)],
      [
        line("k1", "2036-04-01", 1000, "A"),
        line("k2", "2036-04-01", 1000, "B"),
        line("k3", "2036-06-01", 3000, "PAGOS.FLOW.CL", { line_role: "installment_cuota" }),
        line("k4", "2036-06-01", -3000, "PAGOS.FLOW.CL"),
      ]
    );
    expect(byPurchaseKey.size).toBe(0);
    expect(unpaired).toEqual({ ambiguous: 1, no_line: 1 });
    expect(ambiguous).toHaveLength(1);
  });

  it("pairs an interest plan by the principal its statements print", () => {
    const { byPurchaseKey } = matchPaymentReceipts(
      [receipt("a", "2036-11-08 03:59", 295141)],
      [line("plan", "2036-11-08", 323698, "FLOW *COMUNIDAD", { line_role: "installment_purchase_total", principal_clp: 295141 })]
    );
    expect(byPurchaseKey.get("plan")?.message_id).toBe("a");
  });
});
