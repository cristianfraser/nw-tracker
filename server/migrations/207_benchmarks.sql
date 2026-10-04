-- Benchmarks the Rentabilidad table compares an account or group against (shadow portfolio:
-- the same flows on the same dates, into the benchmark). One row per benchmark; `kind` says how
-- its daily total-return level is built (`benchmarkLevels.ts`):
--   equity_with_dividends — `equity_daily` closes of `ticker`, each dividend in `equity_dividends`
--                           reinvested at its ex-date close net of `withholding_pct`
--   fund_unit             — `fund_unit_daily` series `series_key` (already total return)
--   index_plus_rate       — `index_key` ('uf' = uf_daily) compounded at `rate_pct` a year
CREATE TABLE IF NOT EXISTS benchmarks (
  slug TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('equity_with_dividends', 'fund_unit', 'index_plus_rate')),
  label_i18n_key TEXT NOT NULL,
  ticker TEXT,
  withholding_pct REAL,
  series_key TEXT,
  index_key TEXT CHECK (index_key IS NULL OR index_key IN ('uf')),
  rate_pct REAL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  CHECK (
    (kind = 'equity_with_dividends' AND ticker IS NOT NULL AND withholding_pct IS NOT NULL
      AND series_key IS NULL AND index_key IS NULL AND rate_pct IS NULL)
    OR (kind = 'fund_unit' AND series_key IS NOT NULL
      AND ticker IS NULL AND withholding_pct IS NULL AND index_key IS NULL AND rate_pct IS NULL)
    OR (kind = 'index_plus_rate' AND index_key IS NOT NULL AND rate_pct IS NOT NULL
      AND ticker IS NULL AND withholding_pct IS NULL AND series_key IS NULL)
  )
);

-- Cash dividends per share as Yahoo lists them, keyed by ex-date, in the ticker's quote currency.
-- Write-once: a later fetch that disagrees is reported, never written over.
CREATE TABLE IF NOT EXISTS equity_dividends (
  ticker TEXT NOT NULL,
  ex_date TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (currency IN ('usd', 'clp')),
  PRIMARY KEY (ticker, ex_date)
);

INSERT OR IGNORE INTO benchmarks (slug, kind, label_i18n_key, index_key, rate_pct, sort_order)
VALUES ('mortgage', 'index_plus_rate', 'benchmarks.mortgage', 'uf', 4.95, 0);
INSERT OR IGNORE INTO benchmarks (slug, kind, label_i18n_key, ticker, withholding_pct, sort_order)
VALUES ('spy', 'equity_with_dividends', 'benchmarks.spy', 'SPY', 15, 1);
INSERT OR IGNORE INTO benchmarks (slug, kind, label_i18n_key, series_key, sort_order)
VALUES ('risky_norris', 'fund_unit', 'benchmarks.riskyNorris', 'fintual_cert_risky_norris', 2);
INSERT OR IGNORE INTO benchmarks (slug, kind, label_i18n_key, index_key, rate_pct, sort_order)
VALUES ('uf', 'index_plus_rate', 'benchmarks.uf', 'uf', 0, 3);
