import { describe, it, expect } from "vitest";
import {
  expectedGoalsApiNavClp,
  fintualGoalFundPrice,
  fintualGoalKind,
  goalAccruedBalanceQuery,
  parseFintualGoalAccruedBalance,
  type FintualGoalRowWithMatch,
} from "../scripts/fintualRealAssetNav.js";

function row(partial: Partial<FintualGoalRowWithMatch>): FintualGoalRowWithMatch {
  return { id: "1", name: "g", navClp: 0, matchedNotes: null, ...partial };
}

function portfolio(day: string, entries: { ticker: string; shares: number; amount: number }[]) {
  return {
    closureDate: day,
    portfolioSharesBalance: {
      sharesValuationAmount: entries.reduce((n, e) => n + e.amount, 0),
      sharesBreakdown: entries.map((e) => ({ sharesQuantity: e.shares, ticker: e.ticker })),
      tickerValuationAmountsBreakdown: entries.map((e) => ({ amount: e.amount, ticker: e.ticker })),
    },
  };
}

/** Shape of the 2026-09-20 Reserva response: 68,93 cuotas already sold, payout still pending. */
const reserveResponse = {
  balance: {
    calculatedAt: "2026-09-17T22:01:13-03:00",
    closureDate: "2026-09-20",
    accruedValuationAmount: 5_927_401,
    invested: {
      closureDate: "2026-09-20",
      sharesValuationAmount: 5_927_401,
      p0: portfolio("2026-09-20", [{ ticker: "CFMFTLVCSA", shares: 4085.8409, amount: 5_927_401 }]),
    },
    pending: {
      calculatedAt: "2026-09-17T22:01:13-03:00",
      pendingFulfillmentDepositsAmount: 0,
      pendingFulfillmentWithdrawalsAmount: 0,
      pendingPaymentWithdrawalsAmount: 100_000,
    },
  },
};

describe("fintualGoalKind", () => {
  it("dispatches by goal_type + regime", () => {
    expect(fintualGoalKind(row({ goalType: "apv", regime: "a" }))).toBe("apv_a");
    expect(fintualGoalKind(row({ goalType: "apv", regime: "b" }))).toBe("apv_b");
    expect(fintualGoalKind(row({ goalType: "inbox", regime: null }))).toBe("reserve");
    expect(fintualGoalKind(row({ goalType: "investment", regime: null }))).toBe("goal");
  });

  it("is case-insensitive and falls back to the generic goal query", () => {
    expect(fintualGoalKind(row({ goalType: "APV", regime: "A" }))).toBe("apv_a");
    expect(fintualGoalKind(row({ goalType: undefined, regime: undefined }))).toBe("goal");
    expect(fintualGoalKind(row({ goalType: "apv", regime: "c" }))).toBe("goal");
  });
});

describe("goalAccruedBalanceQuery", () => {
  it("selects the right /gql root field and id argument per kind", () => {
    expect(goalAccruedBalanceQuery("apv_a").query).toContain("clApvAGoalLatestAccruedBalance(apvAGoalId: $id");
    expect(goalAccruedBalanceQuery("apv_b").query).toContain("clApvBGoalLatestAccruedBalance(apvBGoalId: $id");
    expect(goalAccruedBalanceQuery("reserve").query).toContain("clReserveLatestAccruedBalance(reserveId: $id");
    expect(goalAccruedBalanceQuery("goal").query).toContain("clGoalLatestAccruedBalance(goalId: $id");
  });

  it("aliases the publish day, asks for Fintual's share count and the cash in transit", () => {
    for (const kind of ["apv_a", "apv_b", "reserve", "goal"] as const) {
      const q = goalAccruedBalanceQuery(kind).query;
      expect(q).toContain("closureDate: investmentClosureDate");
      expect(q).toContain("sharesBreakdown { sharesQuantity ticker }");
      expect(q).toContain("pendingPaymentWithdrawalsAmount");
      expect(q).toContain("p0: ");
    }
  });

  it("reads both the user-owned and the state-bonus portfolios of an APV-A goal", () => {
    expect(goalAccruedBalanceQuery("apv_a").query).toContain("p0: userOwnedPortfolioInvestedBalance");
    expect(goalAccruedBalanceQuery("apv_a").query).toContain("p1: stateOwnedPortfolioInvestedBalance");
    expect(goalAccruedBalanceQuery("reserve").query).not.toContain("p1: ");
  });
});

describe("parseFintualGoalAccruedBalance + fintualGoalFundPrice", () => {
  it("prices the fund from Fintual's own share count, not the ledger's", () => {
    const b = parseFintualGoalAccruedBalance(reserveResponse, "reserva");
    expect(b.closureYmd).toBe("2026-09-20");
    expect(b.sharesValuationClp).toBe(5_927_401);
    expect(b.funds).toEqual([{ ticker: "CFMFTLVCSA", shares: 4085.8409, valuationClp: 5_927_401 }]);
    expect(b.pending).toEqual({
      fulfillmentDepositsClp: 0,
      fulfillmentWithdrawalsClp: 0,
      paymentWithdrawalsClp: 100_000,
    });
    const price = fintualGoalFundPrice(b, "reserva");
    expect(price?.ticker).toBe("CFMFTLVCSA");
    expect(price?.fundPriceClp).toBeCloseTo(1450.7175, 4);
    // The ledger still holds the sold cuotas until payday: 4154,7713 × price ≈ the goals-API nav.
    expect(Math.round(4154.7713 * price!.fundPriceClp)).toBe(6_027_400);
    expect(expectedGoalsApiNavClp(b)).toBe(6_027_401);
  });

  it("sums the user-owned and state-owned portfolios of an APV-A goal per ticker", () => {
    const b = parseFintualGoalAccruedBalance(
      {
        balance: {
          closureDate: "2026-09-20",
          accruedValuationAmount: 49_089_571,
          invested: {
            closureDate: "2026-09-20",
            sharesValuationAmount: 49_089_571,
            p0: portfolio("2026-09-20", [{ ticker: "CFMFTLRNV", shares: 9682.8137, amount: 42_921_456 }]),
            p1: portfolio("2026-09-20", [{ ticker: "CFMFTLRNV", shares: 1391.4885, amount: 6_168_115 }]),
          },
          pending: {
            pendingFulfillmentDepositsAmount: 0,
            pendingFulfillmentWithdrawalsAmount: 0,
            pendingPaymentWithdrawalsAmount: 0,
          },
        },
      },
      "apv-a"
    );
    expect(b.funds).toHaveLength(1);
    expect(b.funds[0]!.shares).toBeCloseTo(11074.3022, 4);
    expect(b.funds[0]!.valuationClp).toBe(49_089_571);
    expect(fintualGoalFundPrice(b, "apv-a")!.fundPriceClp).toBeCloseTo(4432.7462, 4);
  });

  it("returns no price for an empty goal and tolerates an absent portfolio", () => {
    const b = parseFintualGoalAccruedBalance(
      {
        balance: {
          closureDate: "2026-09-20",
          accruedValuationAmount: 0,
          invested: {
            closureDate: "2026-09-20",
            sharesValuationAmount: 0,
            p0: portfolio("2026-09-20", []),
            p1: null,
          },
          pending: {
            pendingFulfillmentDepositsAmount: 0,
            pendingFulfillmentWithdrawalsAmount: 0,
            pendingPaymentWithdrawalsAmount: 0,
          },
        },
      },
      "empty"
    );
    expect(b.funds).toEqual([]);
    expect(fintualGoalFundPrice(b, "empty")).toBeNull();
  });

  it("refuses a goal holding several funds (one fund series per account)", () => {
    const b = parseFintualGoalAccruedBalance(
      {
        balance: {
          closureDate: "2026-09-20",
          accruedValuationAmount: 300,
          invested: {
            closureDate: "2026-09-20",
            sharesValuationAmount: 300,
            p0: portfolio("2026-09-20", [
              { ticker: "AAA", shares: 1, amount: 100 },
              { ticker: "BBB", shares: 2, amount: 200 },
            ]),
          },
          pending: {
            pendingFulfillmentDepositsAmount: 0,
            pendingFulfillmentWithdrawalsAmount: 0,
            pendingPaymentWithdrawalsAmount: 0,
          },
        },
      },
      "mixed"
    );
    expect(() => fintualGoalFundPrice(b, "mixed")).toThrow(/holds 2 funds/);
  });

  it("throws on a portfolio closure day that disagrees with the publish day", () => {
    const bad = structuredClone(reserveResponse);
    bad.balance.invested.p0.closureDate = "2026-09-19";
    expect(() => parseFintualGoalAccruedBalance(bad, "reserva")).toThrow(/closureDate 2026-09-19/);
  });

  it("throws on shares without a valuation entry, and on a missing pending balance", () => {
    const noValuation = structuredClone(reserveResponse);
    noValuation.balance.invested.p0.portfolioSharesBalance.tickerValuationAmountsBreakdown = [];
    expect(() => parseFintualGoalAccruedBalance(noValuation, "reserva")).toThrow(/no valuation entry/);

    const noPending = structuredClone(reserveResponse) as { balance: { pending?: unknown } };
    delete noPending.balance.pending;
    expect(() => parseFintualGoalAccruedBalance(noPending, "reserva")).toThrow(/pending balance missing/);
  });

  it("throws when the response carries no balance at all", () => {
    expect(() => parseFintualGoalAccruedBalance({ balance: null }, "x")).toThrow(/balance missing/);
    expect(() => parseFintualGoalAccruedBalance(undefined, "x")).toThrow(/data missing/);
  });
});
