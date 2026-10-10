import { afterEach, describe, expect, it } from "vitest";
import type { PaymentProcessorReceiptsPayload } from "nw-tracker-contracts";
import { db } from "./db.js";
import {
  loadPaymentProcessorReceipts,
  matchPaymentReceipts,
  storePaymentProcessorReceipts,
  type ReceiptCandidateLine,
  type StoredPaymentReceipt,
} from "./paymentProcessorReceipts.js";

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

  it("pairs a dollar order with the same dollars to the cent, never with pesos", () => {
    const usd = { ...receipt("d", "2036-06-11 21:44", 139.35, "dynavap"), currency: "usd" as const };
    const { byPurchaseKey } = matchPaymentReceipts(
      [usd],
      [
        line("pesos", "2036-06-12", 139, "DYNAVAP LLC"),
        line("cents-off", "2036-06-12", 128000, "DYNAVAP LLC", { amount_usd: 139.3 }),
        line("dollars", "2036-06-12", 128500, "DYNAVAP LLC", { amount_usd: 139.35 }),
      ]
    );
    expect([...byPurchaseKey.keys()]).toEqual(["dollars"]);
  });

  it("pairs a split payment's charges all or none, each with its own line", () => {
    const split = { ...receipt("ml", "2036-04-10 12:00", 15725, "mercadolibre"), charges: [{ amount: 8865, installments: null }, { amount: 6860, installments: null }] };
    const { byPurchaseKey, chargeByPurchaseKey, receiptsPaired } = matchPaymentReceipts(
      [split],
      [line("a", "2036-04-10", 8865, "MERCADOPAGO *SELLERA"), line("b", "2036-04-11", 6860, "MERCADOPAGO *SELLERB"), line("whole", "2036-04-10", 15725, "X")]
    );
    expect(receiptsPaired).toBe(1);
    expect(byPurchaseKey.has("whole")).toBe(false);
    expect(chargeByPurchaseKey.get("a")).toEqual({ position: 1, of: 2 });
    expect(chargeByPurchaseKey.get("b")).toEqual({ position: 2, of: 2 });

    const half = matchPaymentReceipts([split], [line("a", "2036-04-10", 8865, "MERCADOPAGO *SELLERA")]);
    expect(half.byPurchaseKey.size).toBe(0);
    expect(half.unpaired).toEqual({ no_line: 1 });
  });

  it("pairs a receipt with no amount by the store's name or a seller's on the nearest day, after the amounts", () => {
    const amountless = (id: string, paidAt: string, payee = "Mercado Libre") => ({ ...receipt(id, paidAt, 0, "mercadolibre"), amount: null, payee });
    const { byPurchaseKey, ambiguous } = matchPaymentReceipts(
      [amountless("n", "2036-01-20 10:00"), amountless("s", "2036-02-03 10:00", "Tienda Uno SpA"), receipt("amt", "2036-01-20 09:00", 5000, "mercadolibre")],
      [
        line("taken", "2036-01-20", 5000, "MP *MERCADO LIBRE"),
        line("near", "2036-01-21", 74387, "MP *MERCADO LIBRE"),
        line("far", "2036-01-24", 1000, "MERCADOPAGO*MERCADOLIBRE"),
        line("in-person", "2036-01-20", 9000, "MERPAGO*STREAT BURGER"),
        line("seller", "2036-02-03", 22970, "MERCADOPAGO *TIENDAUNO"),
      ]
    );
    expect(ambiguous).toEqual([]);
    expect(byPurchaseKey.get("taken")?.message_id).toBe("amt");
    expect(byPurchaseKey.get("near")?.message_id).toBe("n");
    expect(byPurchaseKey.has("far")).toBe(false);
    expect(byPurchaseKey.has("in-person")).toBe(false);
    expect(byPurchaseKey.get("seller")?.message_id).toBe("s");
  });
});

describe("matchPaymentReceipts: shipments and order confirmations", () => {
  const usd = (id: string, paidAt: string, amount: number, processor: string, order: string, concept: string | null = null): StoredPaymentReceipt => ({
    ...receipt(id, paidAt, amount, processor),
    currency: "usd",
    order_ref: order,
    concept,
  });
  const usdLine = (key: string, on: string, dollars: number) => line(key, on, Math.round(dollars * 900), "AMAZON MKTPL*X1", { amount_usd: dollars });

  it("pairs shipments of one order that no line carries alone with one line of their sum", () => {
    const { byPurchaseKey, receiptsPaired, unpaired } = matchPaymentReceipts(
      [usd("s1", "2036-09-16 14:49", 26.08, "amazon", "114-1", "A"), usd("s2", "2036-09-17 05:23", 28.53, "amazon", "114-1", "B")],
      [usdLine("both", "2036-09-17", 54.61)]
    );
    expect(byPurchaseKey.get("both")).toMatchObject({ amount: 54.61, concept: "A · B", order_ref: "114-1" });
    expect(receiptsPaired).toBe(2);
    expect(unpaired).toEqual({});
  });

  it("reads an order confirmation only for an order none of whose shipments paired, up to 30 days on", () => {
    const { byPurchaseKey, unpaired } = matchPaymentReceipts(
      [
        usd("o1", "2036-03-01 10:00", 50, "amazon_order", "114-1"),
        usd("s1", "2036-03-03 10:00", 50, "amazon", "114-1"),
        usd("o2", "2036-04-01 10:00", 43.58, "amazon_order", "114-2"),
        usd("s2", "2036-04-02 10:00", 143.58, "amazon", "114-2"),
      ],
      [usdLine("ship", "2036-03-03", 50), usdLine("gift-card", "2036-04-20", 43.58)]
    );
    expect(byPurchaseKey.get("ship")?.message_id).toBe("s1");
    expect(byPurchaseKey.get("gift-card")?.message_id).toBe("o2");
    expect(unpaired).toEqual({ no_line: 1 }); // the 143.58 shipment; o1 is not missing a line
  });
});

describe("matchPaymentReceipts: Uber trip summaries", () => {
  const trip = (id: string, paidAt: string, amount: number, processor: string, ref: string): StoredPaymentReceipt => ({
    ...receipt(id, paidAt, amount, processor),
    order_ref: ref,
  });

  it("reads a trip summary only when its trip has no paired receipt", () => {
    const { byPurchaseKey, unpaired } = matchPaymentReceipts(
      [
        trip("sum1", "2036-01-11 14:34", 16786, "uber_trip_summary", "t1"),
        trip("rcp1", "2036-01-11 14:45", 16786, "uber", "t1"),
        trip("sum2", "2036-02-03 09:10", 5200, "uber_trip_summary", "t2"),
      ],
      [line("ride1", "2036-01-11", 16786, "UBER *TRIP"), line("ride2", "2036-02-03", 5200, "UBER *TRIP")]
    );
    expect(byPurchaseKey.get("ride1")?.message_id).toBe("rcp1");
    expect(byPurchaseKey.get("ride2")?.message_id).toBe("sum2");
    expect(unpaired).toEqual({});
  });
});

describe("matchPaymentReceipts: peso receipts charged in dollars", () => {
  const fxDay = "2036-03-02";
  afterEach(() => {
    db.prepare(`DELETE FROM fx_daily WHERE date = ?`).run(fxDay);
  });

  it("pairs an Uber peso receipt with a dollar line naming Uber at the day's rate, never an unnamed one", () => {
    db.prepare(`INSERT OR REPLACE INTO fx_daily (date, clp_per_usd) VALUES (?, ?)`).run(fxDay, 800);
    const { byPurchaseKey } = matchPaymentReceipts(
      [receipt("ride", "2036-03-02 10:00", 8000, "uber"), receipt("flow", "2036-03-02 11:00", 8000, "flow")],
      [
        line("other", "2036-03-02", 8100, "SOME SHOP INC", { amount_usd: 10.1 }),
        line("uber", "2036-03-02", 8150, "UBER BV", { amount_usd: 10.2 }),
      ]
    );
    expect(byPurchaseKey.get("uber")?.message_id).toBe("ride");
    expect(byPurchaseKey.has("other")).toBe(false);
  });
});

describe("storePaymentProcessorReceipts", () => {
  const ID = "<vitest-ml-split@test>";
  afterEach(() => {
    db.prepare(`DELETE FROM payment_processor_receipts WHERE message_id = ?`).run(ID);
  });
  const payload = (charges: { amount: number; installments: number | null }[]): PaymentProcessorReceiptsPayload => ({
    receipts: [
      {
        message_id: ID,
        sent_at_chile: "2036-04-10 12:00",
        processor: "mercadolibre",
        payee: { name: "A, B", rut: null, email: null },
        amount: 15725,
        currency: "clp",
        paid_at_chile: "2036-04-10 12:00",
        order_ref: null,
        concept: "Producto",
        statement_descriptor: null,
        payment_method: null,
        installments: null,
        charges,
      },
    ],
  });

  it("stores a ride and the subscription flag, and reads them back", () => {
    const base = payload([{ amount: 8865, installments: null }, { amount: 6860, installments: null }]).receipts[0]!;
    storePaymentProcessorReceipts({
      receipts: [
        {
          ...base,
          processor: "uber",
          charges: null,
          subscription: true,
          trip: { from: "Calle Uno 100, Providencia", to: "Calle Dos 200, Maipú", started_at_chile: "2036-04-10 11:30", ended_at_chile: "2036-04-10 12:00", distance_km: 12.5 },
        },
      ],
    });
    expect(loadPaymentProcessorReceipts().find((r) => r.message_id === ID)).toMatchObject({
      subscription: true,
      trip: { from: "Calle Uno 100, Providencia", to: "Calle Dos 200, Maipú", started_at_chile: "2036-04-10 11:30", ended_at_chile: "2036-04-10 12:00", distance_km: 12.5 },
    });
  });

  it("stores a split payment's charges and refuses a resend that states other charges", () => {
    const charges = [
      { amount: 8865, installments: null },
      { amount: 6860, installments: 3 },
    ];
    expect(storePaymentProcessorReceipts(payload(charges))).toEqual({ received: 1, new_receipts: 1 });
    expect(storePaymentProcessorReceipts(payload(charges)).new_receipts).toBe(0);
    expect(loadPaymentProcessorReceipts().find((r) => r.message_id === ID)?.charges).toEqual(charges);
    expect(() =>
      storePaymentProcessorReceipts(payload([{ amount: 8865, installments: null }, { amount: 6860, installments: null }]))
    ).toThrow(/other content/);
  });
});
