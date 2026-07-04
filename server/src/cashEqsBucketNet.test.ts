import { describe, expect, it } from "vitest";
import {
  applyCashSavingsNwAdjustment,
  cashSavingsShortfallDashboardRow,
  CASH_SAVINGS_CC_SHORTFALL_CATEGORY_SLUG,
  netLinkedCreditCardFromCashConsolidated,
  syntheticCashSavingsShortfallAccountId,
} from "./cashEqsBucketNet.js";

describe("applyCashSavingsNwAdjustment", () => {
  it("subtracts full linked CC balance from savings", () => {
    expect(applyCashSavingsNwAdjustment(24_403_210, 4_700_303)).toBe(19_702_907);
  });

  it("returns raw savings when CC balance is zero", () => {
    expect(applyCashSavingsNwAdjustment(1_000_000, 0)).toBe(1_000_000);
  });
});

describe("cash savings NW shortfall rows", () => {
  it("cashSavingsShortfallDashboardRow is null when shortfall is zero", () => {
    expect(cashSavingsShortfallDashboardRow(0, "2026-01-15", false)).toBeNull();
  });

  it("appends negative shortfall breakdown when checking cannot cover CC", () => {
    const row = cashSavingsShortfallDashboardRow(250_000, "2026-01-15", false);
    expect(row).not.toBeNull();
    expect(row!.account_id).toBe(syntheticCashSavingsShortfallAccountId());
    expect(row!.current_value_clp).toBe(-250_000);
    expect(row!.category_slug).toBe(CASH_SAVINGS_CC_SHORTFALL_CATEGORY_SLUG);
  });
});

describe("netLinkedCreditCardFromCashConsolidated", () => {
  it("nets closing and prior only; savings net_capital_flow unchanged", () => {
    const input = {
      as_of_date: "2026-03-31",
      closing_value: 1_000_000,
      prior_closing: 900_000,
      net_capital_flow: 50_000,
      stock_units_inflow: 0,
      nominal_pl: 100_000,
      pct_month: 0.11,
      ytd_nominal_pl: 250_000,
      cumulative_nominal_pl: 500_000,
    };
    const consolidated = netLinkedCreditCardFromCashConsolidated([input], "clp");
    const row = consolidated[0]!;
    expect(row.closing_value).toBeLessThanOrEqual(1_000_000);
    expect(row.prior_closing).toBeLessThanOrEqual(900_000);
    expect(row.nominal_pl).toBe(100_000);
    expect(row.net_capital_flow).toBe(50_000);
  });
});
