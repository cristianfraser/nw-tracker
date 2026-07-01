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
  });
});
