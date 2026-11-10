import { describe, expect, it } from "vitest";
import { profileFromFacts, type AccountProfileFacts } from "./accountProfile.js";

const base: AccountProfileFacts = {
  id: 1,
  name: "Vitest",
  importKey: null,
  leafSlug: "cash_eqs__clp",
  kind: "clp",
  equityTicker: null,
  optionContract: null,
  coinPriceTicker: null,
  usesEquityMtm: false,
  fundSeriesKey: null,
  quoteCurrencyOf: (t) => (t.endsWith(".SN") ? "clp" : "usd"),
  fundQuoteCurrencyOf: () => "clp",
  roles: [],
  demoOrTest: true,
};
const p = (f: Partial<AccountProfileFacts>) => profileFromFacts({ ...base, ...f });

describe("profileFromFacts", () => {
  it("picks the quantity source in precedence order", () => {
    expect(p({ kind: "credit_card" }).quantity).toEqual({ kind: "card" });
    expect(p({ kind: "mortgage", roles: [{ role: "loan_of", param: "7" }] }).quantity).toEqual({
      kind: "depto_loan",
      propertyAccountId: 7,
    });
    expect(p({ kind: "property" }).quantity).toEqual({ kind: "depto_property", propertyAccountId: 1 });
    expect(p({ kind: "btc", equityTicker: "BTC-USD", coinPriceTicker: "BTC-USD" }).quantity).toEqual({
      kind: "coin",
      priceTicker: "BTC-USD",
    });
    expect(p({ kind: "spy", equityTicker: "SPY", usesEquityMtm: true }).quantity).toEqual({ kind: "stock", ticker: "SPY" });
    expect(p({ kind: "afc", fundSeriesKey: "afc_cic" }).quantity).toEqual({ kind: "cuota_ledger", seriesKey: "afc_cic" });
    expect(p({ kind: "afc" }).quantity).toEqual({ kind: "book_mark" });
    expect(p({ kind: "afp" }).quantity).toEqual({ kind: "cuota_ledger", seriesKey: "afp_uno_cuota_a" });
    expect(
      p({ kind: "apv", importKey: "import:fintual|cert|key=apv_a", fundSeriesKey: "s", roles: [{ role: "fintual_goal", param: "9" }] })
        .quantity
    ).toEqual({ kind: "fintual_goal", seriesKey: "s", goalId: "9" });
    expect(p({ kind: "cuenta_corriente" }).quantity).toEqual({ kind: "checking_ledger" });
    expect(p({ kind: "usd" }).quantity).toEqual({ kind: "usd_ledger" });
    expect(p({ kind: "clp" }).quantity).toEqual({ kind: "clp_ledger" });
    expect(p({ kind: "dap" }).quantity).toEqual({ kind: "book_mark" });
    // A stock account before its first share keeps its book marks.
    expect(p({ kind: "spy", equityTicker: "SPY" }).quantity).toEqual({ kind: "book_mark" });
  });

  it("maps each quantity to what the account holds", () => {
    expect(p({ kind: "usd" }).holding).toEqual({ kind: "currency", code: "usd" });
    expect(p({ kind: "cuenta_corriente" }).holding).toEqual({ kind: "currency", code: "clp" });
    expect(p({ kind: "property" }).holding).toEqual({ kind: "currency", code: "uf" });
    expect(p({ kind: "credit_card" }).holding).toEqual({ kind: "card" });
    expect(p({ kind: "ipsa", equityTicker: "CFIETFIPSA.SN", usesEquityMtm: true }).holding).toEqual({
      kind: "stock",
      ticker: "CFIETFIPSA.SN",
      quote: "clp",
    });
    expect(p({ kind: "btc", equityTicker: "BTC-USD", coinPriceTicker: "BTC-USD" }).holding).toEqual({
      kind: "coin",
      coin: "BTC",
      priceTicker: "BTC-USD",
      quote: "usd",
    });
    expect(p({ kind: "afp" }).holding).toEqual({ kind: "fund", seriesKey: "afp_uno_cuota_a", quote: "clp" });
    expect(p({ kind: "afc" }).holding).toEqual({ kind: "currency", code: "clp" });
  });

  it("states side, carry, perf builder and the chart's deposit line", () => {
    for (const kind of ["credit_card", "mortgage"]) {
      const q = p({ kind });
      expect([q.side, q.flowCarry, q.chartDeposits]).toEqual(["debt", false, false]);
    }
    expect(p({ kind: "other_debt" }).chartDeposits).toBe(false);
    expect([p({ kind: "dap" }).side, p({ kind: "dap" }).flowCarry]).toEqual(["asset", true]);
    expect(p({ kind: "cuenta_vista" }).perf).toBe("ledger_cash");
    expect(p({ kind: "usd" }).perf).toBe("ledger_cash");
    expect(p({ kind: "cuenta_ahorro_vivienda" }).perf).toBe("book_valuation");
    expect(p({ kind: "cuenta_ahorro_vivienda" }).monthPrecision).toBe(true);
    expect(p({ kind: "dap" }).perf).toBe("valuation_series");
    expect(p({ kind: "usd" }).priceless).toBe(true);
    expect(p({ kind: "spy", equityTicker: "SPY", usesEquityMtm: true }).priceless).toBe(false);
  });

  it("parses the stored roles", () => {
    const r = p({
      kind: "mortgage",
      roles: [
        { role: "loan_of", param: "3" },
        { role: "lender_pattern", param: "A" },
        { role: "lender_pattern", param: "B C" },
      ],
    }).roles;
    expect(r.loanOf).toBe(3);
    expect(r.lenderPatterns).toEqual(["A", "B C"]);
    expect(p({ roles: [{ role: "broker_cash", param: "fintual|usd" }] }).roles.brokerCash).toEqual(["fintual|usd"]);
  });

  it("refuses an account it cannot value", () => {
    expect(() => p({ kind: "mutual_fund", importKey: "import:fintual|cert|key=x" })).toThrow(/fund_series_key/);
    expect(() => p({ kind: "afp", demoOrTest: false })).toThrow(/fund_series_key/);
    expect(() => p({ kind: "spy", usesEquityMtm: true })).toThrow(/equity_ticker/);
    expect(() => p({ kind: "btc", coinPriceTicker: "BTC-USD", usesEquityMtm: true })).toThrow(/coin units/);
    // A US fund account has no UNO fallback, demo or not.
    expect(() => p({ kind: "us_401k" })).toThrow(/fund_series_key/);
    expect(() => p({ kind: "hsa" })).toThrow(/fund_series_key/);
  });

  it("prices a fund holding in its series' currency (a 401(k) on a dollar series)", () => {
    const usd = p({
      kind: "us_401k",
      fundSeriesKey: "vitest_tdf_usd",
      fundQuoteCurrencyOf: (k) => (k === "vitest_tdf_usd" ? "usd" : "clp"),
    });
    expect(usd.quantity).toEqual({ kind: "cuota_ledger", seriesKey: "vitest_tdf_usd" });
    expect(usd.holding).toEqual({ kind: "fund", seriesKey: "vitest_tdf_usd", quote: "usd" });
    expect(usd.priceless).toBe(false);
    expect(p({ kind: "roth_ira", equityTicker: "SPY", usesEquityMtm: true }).holding).toEqual({
      kind: "stock",
      ticker: "SPY",
      quote: "usd",
    });
  });
});
