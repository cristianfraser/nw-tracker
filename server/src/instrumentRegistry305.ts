import type { Database as DatabaseType } from "better-sqlite3";
import { recreateMarketSymbolsWriteLogTrigger } from "./markInputTriggers.js";
import { yahooDisplaySymbol } from "./priceProviders/yahooSymbol.js";

/**
 * Migration 305 hook: every `market_symbols` row written before 305 came from the Yahoo check of a
 * watchlist add, so its display symbol is the Yahoo adapter's suffix rule. Then the write-log
 * trigger is re-created over the new column list. (305 also added `mic`, which 306 dropped; this
 * hook leaves it null.)
 */
export function runInstrumentRegistry305(dbi: DatabaseType): void {
  const rows = dbi.prepare(`SELECT ticker, exchange FROM market_symbols`).all() as { ticker: string; exchange: string | null }[];
  const update = dbi.prepare(`UPDATE market_symbols SET display_symbol = ? WHERE ticker = ?`);
  for (const r of rows) update.run(yahooDisplaySymbol(r.ticker), r.ticker);
  recreateMarketSymbolsWriteLogTrigger(dbi, "305");
}

/** Migration 306 hook: the write-log trigger the SQL dropped with `mic`, over the remaining columns. */
export function runDropMarketSymbolsMic306(dbi: DatabaseType): void {
  recreateMarketSymbolsWriteLogTrigger(dbi, "306");
}
