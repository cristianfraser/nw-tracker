import { describe, expect, it } from "vitest";
import {
  buildStockAccountCreatePreview,
  categorySlugFromTicker,
  defaultStockAccountFormDraft,
  emptyMovementRow,
} from "./stockAccountFormTypes";

describe("stockAccountFormTypes", () => {
  it("derives category slug from ticker", () => {
    expect(categorySlugFromTicker("QQQ")).toBe("qqq");
    expect(categorySlugFromTicker("BRK.B")).toBe("brk_b");
  });

  it("builds preview with initial movements", () => {
    const draft = {
      ...defaultStockAccountFormDraft("brokerage"),
      displayName: "QQQ",
      tickerSymbol: "QQQ",
      categorySlug: "qqq",
      initialMovements: [
        { ...emptyMovementRow("deposit_clp"), occurredOn: "2026-03-01", amountClp: "3000000" },
        { ...emptyMovementRow("compra_usd"), occurredOn: "2026-03-02", amountUsd: "3353.07" },
        {
          ...emptyMovementRow("compra_usd"),
          occurredOn: "2026-03-03",
          unitsDelta: "59.760886574",
        },
      ],
    };
    const preview = buildStockAccountCreatePreview(draft);
    expect(preview?.account.ticker).toBe("QQQ");
    expect(preview?.initial_movements).toHaveLength(3);
    expect(preview?.initial_movements[0]?.amount_clp).toBe(3_000_000);
    expect(preview?.initial_movements[1]?.amount_usd).toBeCloseTo(3353.07, 2);
    expect(preview?.initial_movements[2]?.units_delta).toBeCloseTo(59.760886574, 6);
  });
});
