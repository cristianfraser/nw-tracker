import { describe, expect, it } from "vitest";
import type { FlowCcExpenseLineRow } from "./flowsCreditCardExpenses.js";
import {
  allowedPurchaseMonthsForBill,
  billMonthFromSpentOn,
  displayAmountClp,
  findAmountMatchCandidates,
  pickAutoLinkCandidate,
  purchaseMonthMatchesBillSlot,
  purchaseMonthOffsetFromBill,
  type ExpenseExpectationRow,
} from "./realEstateExpenseMatching.js";
import { merchantMatchesExpectation } from "./realEstateExpenseMerchants.js";

function ccLine(
  overrides: Partial<FlowCcExpenseLineRow> & Pick<FlowCcExpenseLineRow, "purchase_key" | "amount_clp">
): FlowCcExpenseLineRow {
  const { purchase_key, amount_clp, ...rest } = overrides;
  return {
    source: "cc",
    statement_line_id: 1,
    account_id: 1,
    expense_month: "2024-06",
    billing_month: "2024-06",
    purchase_month: "2024-06",
    line_role: "purchase",
    occurred_on: "2024-06-15",
    purchase_on: "2024-06-10",
    statement_date: "15/06/2024",
    merchant: "ENEL",
    merchant_key: "ENEL",
    category_slug: "bills",
    category_unique: false,
    installment_flag: 0,
    nro_cuota_current: null,
    nro_cuota_total: null,
    purchase_notes: "",
    origin_label: "4242",
    amount_usd: null,
    amount_usd_at_expense: null,
    big_group_slug: null,
    origin_card_last4: null,
    primary_card_last4: null,
    purchase_key,
    amount_clp,
    ...rest,
  };
}

function expectation(
  overrides: Partial<ExpenseExpectationRow> & Pick<ExpenseExpectationRow, "id" | "amount_clp">
): ExpenseExpectationRow {
  return {
    spent_on: "2024-05-31",
    category: "electricidad",
    note: null,
    expense_account_id: 2,
    account_slug: "suecia",
    ...overrides,
  };
}

describe("bill month vs purchase month window", () => {
  it("allows purchase months +0, +1, and +2 from bill month", () => {
    expect(allowedPurchaseMonthsForBill("2024-05")).toEqual(["2024-05", "2024-06", "2024-07"]);
    expect(purchaseMonthOffsetFromBill("2024-05", "2024-05")).toBe(0);
    expect(purchaseMonthOffsetFromBill("2024-05", "2024-06")).toBe(1);
    expect(purchaseMonthOffsetFromBill("2024-05", "2024-07")).toBe(2);
    expect(purchaseMonthMatchesBillSlot("2024-05", "2024-05")).toBe(true);
    expect(purchaseMonthMatchesBillSlot("2024-05", "2024-06")).toBe(true);
    expect(purchaseMonthMatchesBillSlot("2024-05", "2024-08")).toBe(false);
  });

  it("derives bill month from spent_on", () => {
    expect(billMonthFromSpentOn("2025-12-31")).toBe("2025-12");
  });
});

describe("merchantMatchesExpectation", () => {
  it("matches ENEL for electricidad", () => {
    expect(merchantMatchesExpectation("suecia", "electricidad", "ENEL DISTRIB")).toBe(true);
  });

  it("matches apartment comunidad for gastos_comunes", () => {
    expect(
      merchantMatchesExpectation("lastarria", "gastos_comunes", "COMUNIDAD VICTORIA SUBERCASEAUX")
    ).toBe(true);
  });
});

describe("pickAutoLinkCandidate", () => {
  it("links when exactly one amount match in the payment window", () => {
    const exp = expectation({ id: 1, amount_clp: 50_000 });
    const line = ccLine({ purchase_key: "a", amount_clp: 50_000 });
    expect(pickAutoLinkCandidate(exp, [line], "2024-05")).toBe(line);
  });

  it("disambiguates with merchant when multiple amount matches", () => {
    const exp = expectation({ id: 1, amount_clp: 50_000, category: "electricidad" });
    const enel = ccLine({ purchase_key: "enel", amount_clp: 50_000, merchant_key: "ENEL", merchant: "ENEL" });
    const other = ccLine({
      purchase_key: "other",
      amount_clp: 50_000,
      merchant_key: "FOO",
      merchant: "FOO",
    });
    expect(pickAutoLinkCandidate(exp, [enel, other], "2024-05")).toBe(enel);
  });

  it("prefers +0 month over +1 when both match merchant", () => {
    const exp = expectation({ id: 1, amount_clp: 50_000, category: "electricidad" });
    const may = ccLine({
      purchase_key: "may",
      amount_clp: 50_000,
      purchase_month: "2024-05",
      purchase_on: "2024-05-20",
      merchant_key: "ENEL",
      merchant: "ENEL",
    });
    const june = ccLine({
      purchase_key: "june",
      amount_clp: 50_000,
      purchase_month: "2024-06",
      purchase_on: "2024-06-05",
      merchant_key: "ENEL",
      merchant: "ENEL",
    });
    expect(pickAutoLinkCandidate(exp, [june, may], "2024-05")).toBe(may);
  });

  it("prefers +1 month over +2 when both match merchant", () => {
    const exp = expectation({ id: 1, amount_clp: 50_000, category: "electricidad" });
    const june = ccLine({
      purchase_key: "june",
      amount_clp: 50_000,
      purchase_month: "2024-06",
      purchase_on: "2024-06-05",
      merchant_key: "FOO",
      merchant: "FOO",
    });
    const july = ccLine({
      purchase_key: "july",
      amount_clp: 50_000,
      purchase_month: "2024-07",
      purchase_on: "2024-07-05",
      merchant_key: "BAR",
      merchant: "BAR",
    });
    const juneEnel = ccLine({
      purchase_key: "june-enel",
      amount_clp: 50_000,
      purchase_month: "2024-06",
      purchase_on: "2024-06-05",
      merchant_key: "ENEL",
      merchant: "ENEL",
    });
    expect(pickAutoLinkCandidate(exp, [july, juneEnel], "2024-05")).toBe(juneEnel);
    expect(pickAutoLinkCandidate(exp, [july, june], "2024-05")).toBeNull();
  });

  it("returns null when ambiguous without merchant match", () => {
    const exp = expectation({ id: 1, amount_clp: 50_000 });
    const a = ccLine({ purchase_key: "a", amount_clp: 50_000, merchant_key: "FOO" });
    const b = ccLine({
      purchase_key: "b",
      amount_clp: 50_000,
      merchant_key: "BAR",
      purchase_month: "2024-07",
      purchase_on: "2024-07-10",
    });
    expect(pickAutoLinkCandidate(exp, [a, b], "2024-05")).toBeNull();
  });
});

describe("findAmountMatchCandidates", () => {
  it("excludes linked and rejected purchase keys", () => {
    const exp = expectation({ id: 1, amount_clp: 10_000 });
    const free = ccLine({ purchase_key: "free", amount_clp: 10_000 });
    const linked = ccLine({ purchase_key: "linked", amount_clp: 10_000 });
    const rejected = ccLine({ purchase_key: "rej", amount_clp: 10_000 });
    const out = findAmountMatchCandidates(
      exp,
      [free, linked, rejected],
      new Set(["linked"]),
      new Set(["rej"])
    );
    expect(out.map((l) => l.purchase_key)).toEqual(["free"]);
  });

  it("excludes purchases outside bill month +0/+1/+2 window", () => {
    const exp = expectation({ id: 1, amount_clp: 10_000 });
    const plusOne = ccLine({ purchase_key: "p1", amount_clp: 10_000, purchase_month: "2024-06" });
    const sameMonth = ccLine({
      purchase_key: "p0",
      amount_clp: 10_000,
      purchase_month: "2024-05",
      purchase_on: "2024-05-10",
    });
    const tooLate = ccLine({
      purchase_key: "late",
      amount_clp: 10_000,
      purchase_month: "2024-08",
      purchase_on: "2024-08-10",
    });
    const out = findAmountMatchCandidates(exp, [plusOne, sameMonth, tooLate], new Set(), new Set());
    expect(out.map((l) => l.purchase_key).sort()).toEqual(["p0", "p1"]);
  });
});

describe("displayAmountClp", () => {
  it("uses linked amount when present", () => {
    const line = ccLine({ purchase_key: "x", amount_clp: 42_000 });
    expect(displayAmountClp(40_000, line)).toBe(42_000);
  });

  it("falls back to expected when unlinked", () => {
    expect(displayAmountClp(40_000, undefined)).toBe(40_000);
  });
});
