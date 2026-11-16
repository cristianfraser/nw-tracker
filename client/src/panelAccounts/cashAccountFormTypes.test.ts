import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cashMovementsCurrency } from "../accountMovementCreate";
import { setDecimalSeparatorForFormatting } from "../format";
import {
  buildCashMovementPostBody,
  cashFlowKindsFor,
  cashFormAllowsTransferCounterpart,
  cashFormCounterpartCurrency,
  cashFormRowFields,
} from "./cashAccountFormTypes";
import { emptyMovementRow } from "./stockAccountFormTypes";

// Amounts are read with the decimal-separator preference — pin it.
beforeEach(() => setDecimalSeparatorForFormatting("comma"));
afterEach(() => setDecimalSeparatorForFormatting("comma"));

describe("the cash movements form, by the account's currency", () => {
  it("reads the currency from the server's schema, and none from another account's", () => {
    const cash = { ledger: "movements", units_delta: "optional", unit_label: "EUR", brokerage_flow_kinds: ["deposit"], cash_currency: "eur" };
    const stock = { ledger: "movements", units_delta: "optional", unit_label: "acciones", brokerage_flow_kinds: ["stock_buy"] };
    expect(cashMovementsCurrency(cash)).toBe("eur");
    expect(cashMovementsCurrency(stock)).toBeNull();
    expect(cashMovementsCurrency(undefined)).toBeNull();
  });

  it("a peso ledger shows one pesos field and offers no conversion", () => {
    expect(cashFormRowFields("deposit", "clp")).toEqual({ pesos: true, own: false });
    expect(cashFormRowFields("other", "clp")).toEqual({ pesos: true, own: false });
    expect(cashFlowKindsFor("clp")).not.toContain("fx_exchange");
    expect(cashFormAllowsTransferCounterpart("deposit", "clp")).toBe(true);
  });

  it("a euro ledger shows its own field, plus pesos on a conversion", () => {
    expect(cashFormRowFields("deposit", "eur")).toEqual({ pesos: false, own: true });
    expect(cashFormRowFields("savings_earnings", "eur")).toEqual({ pesos: false, own: true });
    expect(cashFormRowFields("fx_exchange", "eur")).toEqual({ pesos: true, own: true });
    expect(cashFlowKindsFor("eur")).toContain("fx_exchange");
    expect(cashFormAllowsTransferCounterpart("deposit", "eur")).toBe(false);
  });

  it("a euro deposit posts its amount in euros", () => {
    const row = { ...emptyMovementRow("deposit"), occurredOn: "2026-06-15", amountCash: "1.250,5", amountClp: "999" };
    expect(buildCashMovementPostBody(row, "eur")).toEqual({
      occurred_on: "2026-06-15",
      flow_kind: "deposit",
      amount: 1250.5,
      currency: "eur",
    });
  });

  it("a conversion into euros posts the pesos spent and the euros bought, from the peso source", () => {
    const row = {
      ...emptyMovementRow("fx_exchange"),
      occurredOn: "2026-06-15",
      amountClp: "500.000",
      amountCash: "480,5",
      counterpartAccountId: 7 as const,
    };
    expect(buildCashMovementPostBody(row, "eur")).toEqual({
      occurred_on: "2026-06-15",
      flow_kind: "fx_exchange",
      amount: 500000,
      currency: "clp",
      counter_amount: 480.5,
      counter_currency: "eur",
      counterpart_account_id: 7,
      counterpart_role: "from",
    });
  });

  it("a dividend received on a dollar ledger posts dollars from the paying stock", () => {
    const row = { ...emptyMovementRow("dividend_payout"), occurredOn: "2026-06-15", amountCash: "3,2", counterpartAccountId: 9 as const };
    expect(buildCashMovementPostBody(row, "usd")).toEqual({
      occurred_on: "2026-06-15",
      flow_kind: "dividend_payout",
      amount: 3.2,
      currency: "usd",
      counterpart_account_id: 9,
      counterpart_role: "from",
    });
  });

  it("a peso deposit naming the other account posts one transfer row; without it, a single-leg row", () => {
    const base = { ...emptyMovementRow("deposit"), occurredOn: "2026-06-15", amountClp: "300.000", amountCash: "5" };
    expect(buildCashMovementPostBody({ ...base, counterpartAccountId: 4 }, "clp")).toEqual({
      occurred_on: "2026-06-15",
      amount: 300000,
      currency: "clp",
      counterpart_account_id: 4,
      counterpart_role: "from",
    });
    expect(buildCashMovementPostBody(base, "clp")).toEqual({
      occurred_on: "2026-06-15",
      flow_kind: "deposit",
      amount: 300000,
      currency: "clp",
    });
  });

  it("builds nothing without a date", () => {
    expect(buildCashMovementPostBody(emptyMovementRow("deposit"), "eur")).toBeNull();
  });

  it("names the currency the other account of a row must hold", () => {
    // A conversion's source account holds the pesos spent, whatever the form's currency.
    expect(cashFormCounterpartCurrency("fx_exchange", "usd")).toBe("clp");
    expect(cashFormCounterpartCurrency("fx_exchange", "eur")).toBe("clp");
    // A peso transfer is one row in one currency: the other account holds pesos too.
    expect(cashFormCounterpartCurrency("deposit", "clp")).toBe("clp");
    expect(cashFormCounterpartCurrency("withdrawal", "clp")).toBe("clp");
    // A dividend's counterpart is the paying stock, and the other kinds name no account.
    expect(cashFormCounterpartCurrency("dividend_payout", "usd")).toBeNull();
    expect(cashFormCounterpartCurrency("deposit", "eur")).toBeNull();
    expect(cashFormCounterpartCurrency("savings_earnings", "clp")).toBeNull();
  });
});
