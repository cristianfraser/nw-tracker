-- The instrument registry (2026-11-10, docs/demo-app-features-plan.md §4): an instrument's exchange
-- and currency are registered facts, never read from the spelling of its ticker. `market_symbols`
-- (the name is kept: two functions read it for every mark) gains
--   mic             the exchange's ISO 10383 code (XNYS, XNAS, ARCX, XLON, XSGO); null for a coin or an index;
--   isin            the instrument's ISIN when a provider or a declaration states it;
--   display_symbol  the symbol without a provider's exchange suffix (CSPX, CFIETFIPSA, SPY): what a
--                   leaf name and a position show; filled for the existing rows by the hook
--                   `runInstrumentRegistry305`, which asks the Yahoo adapter's pure suffix rule;
--   source          who stated the facts.
-- Plain ADD COLUMN keeps the table and its mark trigger (which watches quote_currency and
-- market_kind); the write-log UPDATE trigger names every other column, so the hook re-creates it.
ALTER TABLE market_symbols ADD COLUMN mic TEXT;
ALTER TABLE market_symbols ADD COLUMN isin TEXT;
ALTER TABLE market_symbols ADD COLUMN display_symbol TEXT NOT NULL DEFAULT '';
ALTER TABLE market_symbols ADD COLUMN source TEXT NOT NULL DEFAULT 'yahoo' CHECK (source IN ('yahoo', 'coingecko', 'bolsa_santiago', 'declared'));

-- The benchmarks are seeded by migrations (207: SPY, total return net of the 15% US withholding),
-- so the instrument a benchmark names is registered at the same seed. Declared, never asked of a
-- provider inside a migration; a row a watchlist add already wrote is kept.
INSERT OR IGNORE INTO market_symbols (ticker, quote_currency, market_kind, mic, isin, display_symbol, name, exchange, instrument_type, source, verified_at)
VALUES ('SPY', 'usd', 'nyse', 'ARCX', 'US78462F1030', 'SPY', 'SPDR S&P 500 ETF Trust', 'NYSEArca', 'ETF', 'declared', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
