import { db } from "./db.js";
import { CRYPTO_TICKER_COINGECKO_ID } from "./equityCoinGeckoEod.js";
import {
  registerInstrument,
  reloadMarketSymbols,
  unregisteredTickersInUse,
  type InstrumentFacts,
  type InstrumentSource,
  type MarketSymbolRow,
} from "./marketSymbols.js";
import { describeSymbol } from "./priceProviders/index.js";

/**
 * The backfill behind `npm run register:market-symbols` (scripts/register-market-symbols.ts): what
 * the instrument registry lacks or holds differently from what a price provider states now.
 *
 * Provider rule: CoinGecko when it knows the symbol (the coins in `CRYPTO_TICKER_COINGECKO_ID`),
 * else Yahoo. A row declared by the demo generator or a fixture (`source: "declared"`), or stated
 * by the Bolsa adapter (which describes nothing), is not re-verified: it was never a provider's
 * statement.
 */
export type DescribeFn = (symbol: string, provider: InstrumentSource) => Promise<InstrumentFacts>;

export type PlannedRegistration = {
  ticker: string;
  provider: Exclude<InstrumentSource, "declared" | "bolsa_santiago">;
  action: "register" | "update";
  facts: InstrumentFacts;
  /** What differs from the stored row (`update`), e.g. `mic: null → XLON`. */
  changes: string[];
};

export type PlanFailure = { ticker: string; provider: string; error: string };

export type InstrumentRegistrationPlan = { items: PlannedRegistration[]; failures: PlanFailure[] };

export function providerForTicker(ticker: string): "yahoo" | "coingecko" {
  return CRYPTO_TICKER_COINGECKO_ID[ticker.toUpperCase()] != null ? "coingecko" : "yahoo";
}

function factChanges(row: MarketSymbolRow, facts: InstrumentFacts): string[] {
  const out: string[] = [];
  if (row.market_kind !== facts.market_kind) out.push(`market_kind: ${row.market_kind} → ${facts.market_kind}`);
  if (row.quote_currency !== facts.quote_currency) out.push(`quote_currency: ${row.quote_currency} → ${facts.quote_currency}`);
  if (row.mic !== facts.mic) out.push(`mic: ${row.mic ?? "null"} → ${facts.mic ?? "null"}`);
  const display = facts.display_symbol.trim().toUpperCase();
  if (row.display_symbol !== display) out.push(`display_symbol: ${row.display_symbol} → ${display}`);
  return out;
}

/** Asks the providers about every unregistered ticker in use and every provider-stated row; writes nothing. */
export async function planInstrumentRegistration(
  opts: { only?: string[]; describe?: DescribeFn } = {}
): Promise<InstrumentRegistrationPlan> {
  const describe = opts.describe ?? describeSymbol;
  const only = opts.only?.map((t) => t.trim().toUpperCase());
  const stored = db
    .prepare(
      `SELECT ticker, quote_currency, market_kind, mic, isin, display_symbol, name, exchange, instrument_type, source, verified_at
       FROM market_symbols ORDER BY ticker`
    )
    .all() as MarketSymbolRow[];
  const storedByTicker = new Map(stored.map((r) => [r.ticker, r]));
  const wanted = new Set<string>(unregisteredTickersInUse());
  for (const r of stored) if (r.source === "yahoo" || r.source === "coingecko") wanted.add(r.ticker);
  if (only) {
    for (const t of only) {
      if (!wanted.has(t) && !storedByTicker.has(t)) wanted.add(t); // asked for by name: register it
    }
  }
  const items: PlannedRegistration[] = [];
  const failures: PlanFailure[] = [];
  for (const ticker of [...wanted].sort()) {
    if (only && !only.includes(ticker)) continue;
    const row = storedByTicker.get(ticker);
    if (row != null && (row.source === "declared" || row.source === "bolsa_santiago") && !only) continue;
    const provider = providerForTicker(ticker);
    try {
      const facts = await describe(ticker, provider);
      if (row == null) {
        items.push({ ticker, provider, action: "register", facts, changes: [] });
      } else {
        const changes = factChanges(row, facts);
        if (changes.length > 0) items.push({ ticker, provider, action: "update", facts, changes });
      }
    } catch (e) {
      failures.push({ ticker, provider, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { items, failures };
}

class Rollback extends Error {}

/**
 * Writes the plan through `registerInstrument` in one transaction: all or nothing. A refusal
 * (stored bars in another currency, a changed market kind) is collected per ticker and rolls the
 * whole write back; the returned failures name them.
 */
export function applyInstrumentRegistrationPlan(plan: InstrumentRegistrationPlan, now: Date = new Date()): PlanFailure[] {
  const failures: PlanFailure[] = [];
  try {
    db.transaction(() => {
      for (const item of plan.items) {
        try {
          registerInstrument(item.ticker, item.facts, item.provider, now);
        } catch (e) {
          failures.push({ ticker: item.ticker, provider: item.provider, error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (failures.length > 0) throw new Rollback();
    })();
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  } finally {
    reloadMarketSymbols();
  }
  return failures;
}
