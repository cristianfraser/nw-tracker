/**
 * The price providers (docs/demo-app-features-plan.md §4). `describeSymbol` asks a provider what it
 * states about a symbol (Yahoo by default); `priceProvider` returns an adapter by id. Registering the
 * facts is the registry's (`registerInstrument` in `marketSymbols.ts`); see `registerInstrumentFrom`.
 */
import {
  marketSymbol,
  registerInstrument,
  type InstrumentFacts,
  type InstrumentSource,
  type MarketSymbolRow,
} from "../marketSymbols.js";
import { bolsaSantiagoPriceProvider } from "./bolsaSantiago.js";
import { coingeckoPriceProvider } from "./coingecko.js";
import type { PriceProvider } from "./types.js";
import { yahooPriceProvider } from "./yahoo.js";

export type { PriceProvider, ProviderSymbolSearchResult } from "./types.js";

const PROVIDERS: Readonly<Record<Exclude<InstrumentSource, "declared">, PriceProvider>> = {
  yahoo: yahooPriceProvider,
  coingecko: coingeckoPriceProvider,
  bolsa_santiago: bolsaSantiagoPriceProvider,
};

export function priceProvider(id: InstrumentSource): PriceProvider {
  if (id === "declared") throw new Error("a declared instrument has no price provider to ask");
  return PROVIDERS[id];
}

/** What `provider` (default Yahoo) states about `symbol`; throws when the app cannot value it. */
export async function describeSymbol(symbol: string, provider: InstrumentSource = "yahoo"): Promise<InstrumentFacts> {
  return priceProvider(provider).describeSymbol(symbol);
}

/** Asks `provider` about `ticker` and registers what it states (see `registerInstrument`). */
export async function registerInstrumentFrom(
  ticker: string,
  provider: InstrumentSource = "yahoo"
): Promise<MarketSymbolRow> {
  const facts = await describeSymbol(ticker, provider);
  return registerInstrument(ticker, facts, provider);
}

/**
 * The registered row of `ticker`, asking `provider` and registering it first when it has none —
 * the door every creation of something priced by a ticker goes through (a stock account, an option
 * contract's underlying). Async, so call it before the synchronous write that needs the row.
 */
export async function ensureRegisteredInstrument(
  ticker: string,
  provider: InstrumentSource = "yahoo"
): Promise<MarketSymbolRow> {
  const existing = marketSymbol(ticker);
  if (existing != null) return existing;
  return registerInstrumentFrom(ticker, provider);
}
