import { describe, expect, it } from "vitest";
import {
  buildBrokerageMovementPostBody,
  categorySlugFromTicker,
  emptyMovementRow,
} from "./stockAccountFormTypes";

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
});
