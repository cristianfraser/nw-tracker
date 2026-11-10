import type { Database as DatabaseType } from "better-sqlite3";
import { recreateMarketSymbolsWriteLogTrigger305 } from "./markInputTriggers.js";
import { yahooDisplaySymbol, yahooExchangeMic } from "./priceProviders/yahooSymbol.js";

/**
 * Migration 305 hook: every `market_symbols` row written before 305 came from the Yahoo check of a
 * watchlist add, so its display symbol is the Yahoo adapter's suffix rule and its MIC the adapter's
 * reading of the exchange name Yahoo gave (null when the table does not know it). Then the
 * write-log trigger is re-created over the new column list.
 */
export function runInstrumentRegistry305(dbi: DatabaseType): void {
  const rows = dbi.prepare(`SELECT ticker, exchange FROM market_symbols`).all() as { ticker: string; exchange: string | null }[];
  const update = dbi.prepare(`UPDATE market_symbols SET display_symbol = ?, mic = ? WHERE ticker = ?`);
  for (const r of rows) update.run(yahooDisplaySymbol(r.ticker), yahooExchangeMic(null, r.exchange), r.ticker);
  recreateMarketSymbolsWriteLogTrigger305(dbi);
}
