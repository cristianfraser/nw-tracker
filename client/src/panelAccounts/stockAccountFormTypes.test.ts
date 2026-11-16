import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDecimalSeparatorForFormatting } from "../format";
import {
  BROKERAGE_FLOW_KINDS,
  CLP_CASH_FLOW_KINDS,
  FOREIGN_CASH_FLOW_KINDS,
  OPTION_CONTRACT_FLOW_KINDS,
} from "./brokerageFlowKinds";
import {
  buildBrokerageMovementPostBody,
  cashCurrencyByAccountId,
  categorySlugFromTicker,
  defaultMovementRowKind,
  draftSettlementCurrency,
  emptyMovementRow,
  stockFormKindSettlesInCash,
  stockFormRowFields,
} from "./stockAccountFormTypes";

// Amounts are read with the decimal-separator preference — pin it so tests don't depend on
// the machine timezone that seeds it.
beforeEach(() => setDecimalSeparatorForFormatting("comma"));
afterEach(() => setDecimalSeparatorForFormatting("comma"));

/** The accounts list as the server sends it: a dollar, a peso and a euro cash ledger, and a stock. */
const ACCOUNTS = [
  { id: 90, cash_currency: "usd" },
  { id: 96, cash_currency: "clp" },
  { id: 97, cash_currency: "eur" },
  { id: 40, cash_currency: null },
  { id: 41 },
];
const CASH = cashCurrencyByAccountId(ACCOUNTS);

describe("stockAccountFormTypes", () => {
  it("slugifies a ticker into a category slug", () => {
    expect(categorySlugFromTicker("BTC-USD")).toBe("btc_usd");
  });

  it("reads each cash ledger's currency from the accounts list, and none for another account", () => {
    expect([...CASH.entries()]).toEqual([
      [90, "usd"],
      [96, "clp"],
      [97, "eur"],
    ]);
    const row = { ...emptyMovementRow("stock_buy"), counterpartAccountId: 97 as const };
    expect(draftSettlementCurrency(row, CASH)).toBe("eur");
    expect(draftSettlementCurrency({ ...row, counterpartAccountId: 40 }, CASH)).toBeNull();
    expect(draftSettlementCurrency({ ...row, counterpartAccountId: "" }, CASH)).toBeNull();
  });

  it("a trade, a dividend and a premium show the cash account's field; the account's own rows show pesos", () => {
    for (const kind of ["stock_buy", "stock_sell", "dividend_payout", "option_sell_open", "option_buy_close"] as const) {
      expect(stockFormKindSettlesInCash(kind)).toBe(true);
      expect(stockFormRowFields(kind)).toEqual({ pesos: false, cash: true });
    }
    for (const kind of ["deposit", "withdrawal", "other"] as const) {
      expect(stockFormKindSettlesInCash(kind)).toBe(false);
      expect(stockFormRowFields(kind)).toEqual({ pesos: true, cash: false });
    }
    expect(stockFormRowFields("option_expire")).toEqual({ pesos: false, cash: false });
    // Every kind either form offers shows at most one amount field.
    for (const kind of [...BROKERAGE_FLOW_KINDS, ...OPTION_CONTRACT_FLOW_KINDS]) {
      const f = stockFormRowFields(kind);
      expect(f.pesos && f.cash).toBe(false);
    }
  });

  it("stock_buy posts its amount in the chosen cash account's currency, the cash account as source", () => {
    const row = {
      ...emptyMovementRow("stock_buy"),
      occurredOn: "2026-06-15",
      amountCash: "100",
      amountClp: "999", // stale hidden-field value must not be sent
      unitsDelta: "1",
      counterpartAccountId: 90 as const,
    };
    expect(buildBrokerageMovementPostBody(row, CASH)).toEqual({
      occurred_on: "2026-06-15",
      flow_kind: "stock_buy",
      amount: 100,
      currency: "usd",
      units_delta: 1,
      counterpart_account_id: 90,
      counterpart_role: "from",
    });
  });

  it("the same stock bought from euro cash posts euros, and from peso cash pesos", () => {
    const row = {
      ...emptyMovementRow("stock_buy"),
      occurredOn: "2026-07-03",
      amountCash: "2.985.000",
      unitsDelta: "2282",
    };
    const euros = buildBrokerageMovementPostBody({ ...row, counterpartAccountId: 97 }, CASH);
    expect(euros).toMatchObject({ amount: 2_985_000, currency: "eur", counterpart_account_id: 97, counterpart_role: "from" });
    expect(euros).not.toHaveProperty("counter_amount");
    const pesos = buildBrokerageMovementPostBody({ ...row, counterpartAccountId: 96 }, CASH);
    expect(pesos).toMatchObject({ amount: 2_985_000, currency: "clp", units_delta: 2282 });
    expect(pesos).not.toHaveProperty("ticker");
  });

  it("stock_sell credits the cash account (to)", () => {
    const row = {
      ...emptyMovementRow("stock_sell"),
      occurredOn: "2026-06-15",
      amountCash: "50",
      unitsDelta: "1",
      counterpartAccountId: 97 as const,
    };
    expect(buildBrokerageMovementPostBody(row, CASH)).toMatchObject({ currency: "eur", counterpart_role: "to" });
  });

  it("dividend_payout: the cash account receives (to) in its own currency, pesos included, and no units", () => {
    const row = {
      ...emptyMovementRow("dividend_payout"),
      occurredOn: "2026-03-24",
      amountCash: "0,54",
      unitsDelta: "9", // stale hidden-field value must not be sent
      counterpartAccountId: 90 as const,
    };
    const body = buildBrokerageMovementPostBody(row, CASH);
    expect(body).toEqual({
      occurred_on: "2026-03-24",
      flow_kind: "dividend_payout",
      amount: 0.54,
      currency: "usd",
      counterpart_account_id: 90,
      counterpart_role: "to",
    });
    const intoPesos = buildBrokerageMovementPostBody({ ...row, amountCash: "60.000", counterpartAccountId: 96 }, CASH);
    expect(intoPesos).toMatchObject({ amount: 60_000, currency: "clp", counterpart_role: "to" });
  });

  it("a trade with no cash account chosen, or an account that is not a cash ledger, has no body", () => {
    const row = { ...emptyMovementRow("stock_buy"), occurredOn: "2026-06-15", amountCash: "100", unitsDelta: "1" };
    expect(buildBrokerageMovementPostBody(row, CASH)).toBeNull();
    expect(buildBrokerageMovementPostBody({ ...row, counterpartAccountId: 40 }, CASH)).toBeNull();
    expect(buildBrokerageMovementPostBody({ ...row, occurredOn: "", counterpartAccountId: 90 }, CASH)).toBeNull();
  });

  it("an option premium posts in the chosen cash account's currency with its contracts", () => {
    const row = {
      ...emptyMovementRow("option_sell_open"),
      occurredOn: "2026-06-15",
      amountCash: "120,5",
      unitsDelta: "2",
      counterpartAccountId: 90 as const,
    };
    expect(buildBrokerageMovementPostBody(row, CASH)).toEqual({
      occurred_on: "2026-06-15",
      flow_kind: "option_sell_open",
      amount: 120.5,
      currency: "usd",
      units_delta: 2,
      counterpart_account_id: 90,
      counterpart_role: "to",
    });
    const expiry = { ...emptyMovementRow("option_expire"), occurredOn: "2026-06-20", unitsDelta: "2", amountCash: "5", amountClp: "5" };
    expect(buildBrokerageMovementPostBody(expiry, CASH)).toEqual({ occurred_on: "2026-06-20", flow_kind: "option_expire", units_delta: 2 });
  });

  it("the account's own deposit is pesos and never reads the cash field", () => {
    const row = {
      ...emptyMovementRow("deposit"),
      occurredOn: "2026-06-15",
      amountClp: "3.000.000",
      amountCash: "123", // stale hidden-field value must not be sent
      counterpartAccountId: 90 as const, // a counterpart left from another kind is not sent
    };
    expect(buildBrokerageMovementPostBody(row, CASH)).toEqual({
      occurred_on: "2026-06-15",
      flow_kind: "deposit",
      amount: 3_000_000,
      currency: "clp",
    });
  });

  it("reads an ambiguous amount with the decimal-separator setting", () => {
    const row = {
      ...emptyMovementRow("stock_buy"),
      occurredOn: "2026-06-15",
      amountCash: "1.500",
      unitsDelta: "0,25",
      counterpartAccountId: 90 as const,
    };
    expect(buildBrokerageMovementPostBody(row, CASH)?.amount).toBe(1500);
    setDecimalSeparatorForFormatting("period");
    const body = buildBrokerageMovementPostBody(row, CASH);
    expect(body?.amount).toBe(1.5);
    // Unambiguous input reads the same under either setting.
    expect(body?.units_delta).toBe(0.25);
  });

  it("throws the localized message when an amount isn't a number", () => {
    const row = {
      ...emptyMovementRow("stock_buy"),
      occurredOn: "2026-06-15",
      amountCash: "1.50.000",
      unitsDelta: "1",
      counterpartAccountId: 90 as const,
    };
    expect(() => buildBrokerageMovementPostBody(row, CASH)).toThrow("1.50.000");
  });
});

describe("the kind a new row starts on", () => {
  it("is a share buy on a stock form and the form's first kind elsewhere, always one the form offers", () => {
    expect(defaultMovementRowKind(BROKERAGE_FLOW_KINDS)).toBe("stock_buy");
    expect(defaultMovementRowKind(OPTION_CONTRACT_FLOW_KINDS)).toBe("option_sell_open");
    expect(defaultMovementRowKind(CLP_CASH_FLOW_KINDS)).toBe("deposit");
    expect(defaultMovementRowKind(FOREIGN_CASH_FLOW_KINDS)).toBe("deposit");
    for (const kinds of [BROKERAGE_FLOW_KINDS, OPTION_CONTRACT_FLOW_KINDS, CLP_CASH_FLOW_KINDS, FOREIGN_CASH_FLOW_KINDS]) {
      expect(kinds).toContain(defaultMovementRowKind(kinds));
    }
    expect(() => defaultMovementRowKind([])).toThrow("no flow kinds");
  });
});
