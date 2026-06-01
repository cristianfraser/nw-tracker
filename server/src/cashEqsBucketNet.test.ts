import { describe, expect, it } from "vitest";
import {
  cashSavingsShortfallDashboardRow,
  creditCardShortfallClp,
  CASH_SAVINGS_CC_SHORTFALL_CATEGORY_SLUG,
  netLinkedCreditCardFromCashConsolidated,
  syntheticCashSavingsShortfallAccountId,
} from "./cashEqsBucketNet.js";

describe("creditCardShortfallClp", () => {
  it("returns zero when checking covers the card", () => {
    expect(creditCardShortfallClp(500_000, 400_000)).toBe(0);
    expect(creditCardShortfallClp(400_000, 400_000)).toBe(0);
  });

  it("returns uncovered amount when checking is below card balance", () => {
    expect(creditCardShortfallClp(100_000, 400_000)).toBe(300_000);
  });

  it("returns zero when card balance is zero or negative", () => {
    expect(creditCardShortfallClp(0, 0)).toBe(0);
    expect(creditCardShortfallClp(100_000, 0)).toBe(0);
  });

  it("treats negative checking as zero coverage (shortfall capped at CC balance)", () => {
    expect(creditCardShortfallClp(-4_989_420, 10_780_904)).toBe(10_780_904);
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

describe("netLinkedCreditCardFromCashConsolidated shortfall", () => {
  it("subtracts only conditional shortfall from closing and prior", () => {
    const consolidated = netLinkedCreditCardFromCashConsolidated(
      [
        {
          as_of_date: "2026-03-31",
          closing_value: 1_000_000,
          prior_closing: 900_000,
          net_capital_flow: 0,
          stock_units_inflow: 0,
          nominal_pl: 100_000,
          pct_month: null,
          ytd_nominal_pl: null,
          cumulative_nominal_pl: null,
        },
      ],
      "clp"
    );
    expect(consolidated[0]!.closing_value).toBeLessThanOrEqual(1_000_000);
    expect(consolidated[0]!.prior_closing).toBeLessThanOrEqual(900_000);
  });
});
