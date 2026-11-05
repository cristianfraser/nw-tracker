-- Stock splits per ticker (`equitySplits.ts`). A split multiplies every share by
-- numerator / denominator from its ex-date (the NYSE / Bolsa session it took effect on).
-- `equity_daily` / `equity_dividends` / `live_market_quotes` are kept split-adjusted (Yahoo's
-- convention): recording a split rescales their rows before the ex-date once, in the same
-- transaction. The share count changes through a `stock_split` movement on each holder.
-- Write-once: another source stating a different ratio for the same ex-date is an error.
CREATE TABLE IF NOT EXISTS equity_splits (
  ticker TEXT NOT NULL,
  ex_date TEXT NOT NULL CHECK (ex_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  numerator REAL NOT NULL CHECK (numerator > 0),
  denominator REAL NOT NULL CHECK (denominator > 0),
  source TEXT NOT NULL CHECK (source IN ('yahoo', 'broker', 'manual')),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (ticker, ex_date),
  CHECK (numerator != denominator)
)
