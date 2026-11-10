/**
 * A price provider behind one interface (docs/demo-app-features-plan.md §4). Each adapter is the
 * only code that knows its provider's symbols and payloads; the rest of the server asks the
 * instrument registry (`marketSymbols.ts`) for an instrument's facts and the adapters for prices.
 *
 * Every method but {@link PriceProvider.describeSymbol} is optional, and an adapter states only
 * what its provider really does: Yahoo describes, searches and serves daily closes and live quotes;
 * CoinGecko and the Bolsa de Santiago serve daily closes only (their fetchers stay where they are,
 * `equityCoinGeckoEod.ts` / `equityBolsaSantiagoEod.ts`, and the adapters declare them).
 */
import type { InstrumentFacts, InstrumentSource } from "../marketSymbols.js";
import type { EodCloseSeries, YahooLiveQuote } from "../equityYahooEod.js";

export type ProviderSymbolSearchResult = {
  symbol: string;
  name: string | null;
  exchange: string | null;
  /** The provider's display type: `Equity`, `ETF`, `Index`, `Cryptocurrency`, … */
  type: string | null;
};

export type PriceProvider = {
  id: InstrumentSource;
  /** What the provider states about `symbol`; throws when it cannot be valued by the app. */
  describeSymbol(symbol: string): Promise<InstrumentFacts>;
  /** Symbols matching what a person typed. */
  search?(query: string): Promise<ProviderSymbolSearchResult[]>;
  /**
   * Daily closes, ascending trade dates, in the instrument's quote currency: the last `recentDays`
   * calendar days, or the provider's whole history when omitted.
   */
  dailyCloses?(symbol: string, opts?: { recentDays?: number }): Promise<EodCloseSeries>;
  /** The current regular-hours quote. */
  liveQuote?(symbol: string): Promise<YahooLiveQuote>;
};
