import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  applyInstrumentRegistrationPlan,
  planInstrumentRegistration,
  providerForTicker,
  type DescribeFn,
} from "./instrumentRegistrationPlan.js";
import { marketSymbol, registerInstrument, reloadMarketSymbols, type InstrumentFacts } from "./marketSymbols.js";

const A = "ZZPLANA.XX";
const B = "ZZPLANB.XX";
const facts = (over: Partial<InstrumentFacts> = {}): InstrumentFacts => ({
  quote_currency: "usd",
  market_kind: "nyse",
  mic: "XNYS",
  exchange: null,
  name: null,
  instrument_type: "EQUITY",
  display_symbol: "ZZPLAN",
  ...over,
});

/** A stored daily bar puts a ticker "in use". */
function useInAccounts(ticker: string, currency = "usd"): void {
  db.prepare(`INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, '2026-01-02', 10, ?)`).run(ticker, currency);
}

afterEach(() => {
  for (const t of [A, B]) {
    db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(t);
    db.prepare(`DELETE FROM market_symbols WHERE ticker = ?`).run(t);
  }
  reloadMarketSymbols();
});

describe("planInstrumentRegistration", () => {
  it("picks CoinGecko for the coins it knows and Yahoo for the rest", () => {
    expect(providerForTicker("btc-usd")).toBe("coingecko");
    expect(providerForTicker("SPY")).toBe("yahoo");
  });

  it("lists an unregistered ticker in use and writes it with --apply, idempotently", async () => {
    useInAccounts(A);
    const describe_: DescribeFn = async () => facts();
    const plan = await planInstrumentRegistration({ only: [A], describe: describe_ });
    expect(plan.failures).toEqual([]);
    expect(plan.items.map((i) => [i.ticker, i.action])).toEqual([[A, "register"]]);
    expect(marketSymbol(A)).toBeNull(); // planning writes nothing

    expect(applyInstrumentRegistrationPlan(plan)).toEqual([]);
    expect(marketSymbol(A)).toMatchObject({ market_kind: "nyse", mic: "XNYS", display_symbol: "ZZPLAN", source: "yahoo" });

    const again = await planInstrumentRegistration({ only: [A], describe: describe_ });
    expect(again.items).toEqual([]);
  });

  it("reports a provider-stated row whose facts changed, and leaves declared rows alone", async () => {
    registerInstrument(A, facts({ mic: null }), "yahoo");
    registerInstrument(B, facts({ mic: null }), "declared");
    const plan = await planInstrumentRegistration({ describe: async () => facts() });
    const mine = plan.items.filter((i) => i.ticker === A || i.ticker === B);
    expect(mine.map((i) => i.ticker)).toEqual([A]);
    expect(mine[0]!.changes).toEqual(["mic: null → XNYS"]);
    expect(applyInstrumentRegistrationPlan({ items: mine, failures: [] })).toEqual([]);
    expect(marketSymbol(A)!.mic).toBe("XNYS");
  });

  it("collects every provider failure by ticker", async () => {
    useInAccounts(A);
    useInAccounts(B);
    const plan = await planInstrumentRegistration({
      only: [A, B],
      describe: async (t) => {
        throw new Error(`cannot classify ${t}`);
      },
    });
    expect(plan.items).toEqual([]);
    expect(plan.failures.map((f) => f.ticker)).toEqual([A, B]);
  });

  it("writes nothing when registerInstrument refuses one ticker", async () => {
    useInAccounts(A);
    useInAccounts(B, "clp");
    const plan = await planInstrumentRegistration({ only: [A, B], describe: async () => facts() });
    expect(plan.items).toHaveLength(2);
    const refused = applyInstrumentRegistrationPlan(plan);
    expect(refused.map((f) => f.ticker)).toEqual([B]);
    expect(marketSymbol(A)).toBeNull();
    expect(marketSymbol(B)).toBeNull();
  });
});
