import { describe, expect, it } from "vitest";
import { cardPaymentEvidence, cardPaymentMoney, type CardPaymentTransfer } from "./latestCardPayments.js";
import { isPaymentLine } from "./expensePaymentNames.js";

const PAID = 9101;
const PAYING = 9102;
const CHECKING = 9103;

function transfer(p: Partial<CardPaymentTransfer> & { movement_id: number }): CardPaymentTransfer {
  return {
    from_account_id: CHECKING,
    from_name: "Cuenta corriente",
    to_account_id: PAID,
    occurred_on: "2036-03-07",
    amount: 500_000,
    currency: "clp",
    counter_amount: null,
    counter_currency: null,
    part: null,
    ...p,
  };
}

type L = Parameters<typeof cardPaymentEvidence>[1][number] & { primary_card_last4: null; statement_line_id: number; purchase_key: string };
function line(p: Partial<L> & { account_id: number; amount_clp: number }): L {
  return {
    source: "cc",
    statement_line_id: 1,
    purchase_key: "k",
    line_role: "purchase",
    merchant: "SHOP",
    amount_usd: null,
    purchase_on: "2036-03-07",
    posting_on: null,
    primary_card_last4: null,
    ...p,
  } as L;
}

describe("cardPaymentEvidence", () => {
  it("folds the PAGO a bank-account transfer paid, and the paying charge of a card-to-card one", () => {
    const fromChecking = transfer({ movement_id: 1 });
    const cardToCard = transfer({ movement_id: 2, from_account_id: PAYING, from_name: "santander", occurred_on: "2036-04-05", amount: 300_000, part: { kind: "charge", flow_id: 77 } });
    const lines = [
      line({ account_id: PAID, amount_clp: -500_000, merchant: "PAGO" }),
      line({ account_id: PAYING, amount_clp: 300_000, merchant: "EXPRESS PLAZA L", purchase_on: "2036-04-05", flow_id: 77 }),
      line({ account_id: PAID, amount_clp: -300_000, merchant: "PAGO", purchase_on: "2036-04-05" }),
      line({ account_id: PAID, amount_clp: 12_000, merchant: "SHOP" }),
    ];
    const ev = cardPaymentEvidence([fromChecking, cardToCard], lines, (l) => isPaymentLine(l as never));
    expect(ev.get(1)).toEqual([0]);
    expect(ev.get(2)).toEqual([1, 2]);
  });

  it("gives a payment line two transfers share to neither", () => {
    const a = transfer({ movement_id: 1 });
    const b = transfer({ movement_id: 2 });
    const ev = cardPaymentEvidence([a, b], [line({ account_id: PAID, amount_clp: -500_000, merchant: "PAGO" })], (l) => isPaymentLine(l as never));
    expect([...ev.values()].flat()).toEqual([]);
  });
});

describe("cardPaymentMoney", () => {
  it("states a divisas purchase in the pesos that left and the dollars the card got", () => {
    expect(cardPaymentMoney(transfer({ movement_id: 3, amount: 950_000, counter_amount: 1_000, counter_currency: "usd" }))).toEqual({
      amount: { value: 950_000, currency: "clp" },
      values: { clp: { value: 950_000, rate_source: "native" }, usd: { value: 1_000, rate_source: "paid" } },
    });
  });
});
