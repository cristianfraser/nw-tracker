import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDecimalSeparatorForFormatting } from "../format";
import {
  buildBrokerageMovementPostBody,
  categorySlugFromTicker,
  emptyMovementRow,
} from "./stockAccountFormTypes";

// Amounts are read with the decimal-separator preference — pin it so tests don't depend on
// the machine timezone that seeds it.
beforeEach(() => setDecimalSeparatorForFormatting("comma"));
afterEach(() => setDecimalSeparatorForFormatting("comma"));

describe("stockAccountFormTypes", () => {
  it("slugifies a ticker into a category slug", () => {
    expect(categorySlugFromTicker("BTC-USD")).toBe("btc_usd");
  });

  it("stock_buy uses counterpart as USD source (from)", () => {
    const row = {
      ...emptyMovementRow("stock_buy"),
      occurredOn: "2026-06-15",
      amountUsd: "100",
      unitsDelta: "1",
      counterpartAccountId: 90 as const,
    };
    const body = buildBrokerageMovementPostBody(row, "LIN");
    expect(body?.counterpart_role).toBe("from");
    expect(body?.counterpart_account_id).toBe(90);
    expect(body?.amount).toBe(100);
    expect(body?.currency).toBe("usd");
    expect(body).not.toHaveProperty("counter_amount");
  });

  it("dividend_payout on the stock form: counterpart is the receiving USD cash (to), no units", () => {
    const row = {
      ...emptyMovementRow("dividend_payout"),
      occurredOn: "2026-03-24",
      amountUsd: "0,54",
      unitsDelta: "9", // stale hidden-field value must not be sent
      counterpartAccountId: 90 as const,
    };
    const body = buildBrokerageMovementPostBody(row, "VEA");
    expect(body?.counterpart_role).toBe("to");
    expect(body?.amount).toBe(0.54);
    expect(body?.currency).toBe("usd");
    expect(body).not.toHaveProperty("units_delta");
  });

  it("stock_buy for a .SN (CLP-quoted) stock sends a CLP amount and never a USD leg", () => {
    const row = {
      ...emptyMovementRow("stock_buy"),
      occurredOn: "2026-07-03",
      amountClp: "2.985.000",
      amountUsd: "123", // stale hidden-field value must not be sent
      unitsDelta: "2282",
      counterpartAccountId: 96 as const,
    };
    const body = buildBrokerageMovementPostBody(row, "CFIETFIPSA.SN");
    expect(body?.amount).toBe(2_985_000);
    expect(body?.currency).toBe("clp");
    expect(body).not.toHaveProperty("counter_amount");
    expect(body?.counterpart_role).toBe("from");
    expect(body?.units_delta).toBe(2282);
    expect(body?.ticker).toBe("CFIETFIPSA.SN");
  });

  it("reads an ambiguous amount with the decimal-separator setting", () => {
    const row = {
      ...emptyMovementRow("stock_buy"),
      occurredOn: "2026-06-15",
      amountUsd: "1.500",
      unitsDelta: "0,25",
      counterpartAccountId: 90 as const,
    };
    expect(buildBrokerageMovementPostBody(row, "LIN")?.amount).toBe(1500);
    setDecimalSeparatorForFormatting("period");
    const body = buildBrokerageMovementPostBody(row, "LIN");
    expect(body?.amount).toBe(1.5);
    // Unambiguous input reads the same under either setting.
    expect(body?.units_delta).toBe(0.25);
  });

  it("throws the localized message when an amount isn't a number", () => {
    const row = {
      ...emptyMovementRow("stock_buy"),
      occurredOn: "2026-06-15",
      amountUsd: "1.50.000",
      unitsDelta: "1",
      counterpartAccountId: 90 as const,
    };
    expect(() => buildBrokerageMovementPostBody(row, "LIN")).toThrow("1.50.000");
  });
});
