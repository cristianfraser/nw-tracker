import { describe, expect, it } from "vitest";
import {
  buildBrokerageMovementPostBody,
  buildStockAccountCreatePreview,
  categorySlugFromTicker,
  defaultStockAccountFormDraft,
  emptyMovementRow,
} from "./stockAccountFormTypes";

describe("stockAccountFormTypes", () => {
  it("builds preview with initial movements", () => {
    const draft = {
      ...defaultStockAccountFormDraft("brokerage"),
      displayName: "QQQ",
      tickerSymbol: "QQQ",
      initialMovements: [
        { ...emptyMovementRow("deposit_clp"), occurredOn: "2026-03-01", amountClp: "3000000" },
        { ...emptyMovementRow("compra_usd"), occurredOn: "2026-03-02", amountUsd: "3353.07" },
        {
          ...emptyMovementRow("stock_buy"),
          occurredOn: "2026-03-03",
          amountUsd: "3353.07",
          unitsDelta: "59.760886574",
        },
      ],
    };
    const preview = buildStockAccountCreatePreview(draft);
    expect(preview?.account.ticker).toBe("QQQ");
    expect(preview?.account.category_slug).toBe("qqq");
    expect(preview?.initial_movements).toHaveLength(3);
    expect(preview?.initial_movements[0]?.amount_clp).toBe(3_000_000);
    expect(preview?.initial_movements[1]?.amount_usd).toBeCloseTo(3353.07, 2);
    expect(preview?.initial_movements[2]?.units_delta).toBeCloseTo(59.760886574, 6);
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
