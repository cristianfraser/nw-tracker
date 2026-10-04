-- Benchmarks can be one of the user's own portfolio groups (kind `portfolio_group`): its level is
-- the group's own time-weighted daily return chained (`benchmarkLevels.ts`), so the mortgage
-- prepayments (and the Rentabilidad tables) can be followed into what that group actually
-- earned. The kind list is a CHECK, so the table is rebuilt; nothing references it.
CREATE TABLE benchmarks_new (
  slug TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('equity_with_dividends', 'fund_unit', 'index_plus_rate', 'portfolio_group')),
  label_i18n_key TEXT,
  ticker TEXT,
  withholding_pct REAL,
  series_key TEXT,
  index_key TEXT CHECK (index_key IS NULL OR index_key IN ('uf')),
  rate_pct REAL,
  portfolio_group_slug TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  CHECK (
    (kind = 'equity_with_dividends' AND ticker IS NOT NULL AND withholding_pct IS NOT NULL
      AND series_key IS NULL AND index_key IS NULL AND rate_pct IS NULL AND portfolio_group_slug IS NULL
      AND label_i18n_key IS NOT NULL)
    OR (kind = 'fund_unit' AND series_key IS NOT NULL
      AND ticker IS NULL AND withholding_pct IS NULL AND index_key IS NULL AND rate_pct IS NULL
      AND portfolio_group_slug IS NULL AND label_i18n_key IS NOT NULL)
    OR (kind = 'index_plus_rate' AND index_key IS NOT NULL AND rate_pct IS NOT NULL
      AND ticker IS NULL AND withholding_pct IS NULL AND series_key IS NULL AND portfolio_group_slug IS NULL
      AND label_i18n_key IS NOT NULL)
    OR (kind = 'portfolio_group' AND portfolio_group_slug IS NOT NULL
      AND ticker IS NULL AND withholding_pct IS NULL AND series_key IS NULL AND index_key IS NULL
      AND rate_pct IS NULL AND label_i18n_key IS NULL)
  )
);
INSERT INTO benchmarks_new (slug, kind, label_i18n_key, ticker, withholding_pct, series_key, index_key, rate_pct, sort_order)
SELECT slug, kind, label_i18n_key, ticker, withholding_pct, series_key, index_key, rate_pct, sort_order FROM benchmarks;
DROP TABLE benchmarks;
ALTER TABLE benchmarks_new RENAME TO benchmarks;

INSERT INTO benchmarks (slug, kind, portfolio_group_slug, sort_order) VALUES ('pg:brokerage', 'portfolio_group', 'brokerage', 10);
INSERT INTO benchmarks (slug, kind, portfolio_group_slug, sort_order) VALUES ('pg:brokerage_acciones', 'portfolio_group', 'brokerage_acciones', 11);
INSERT INTO benchmarks (slug, kind, portfolio_group_slug, sort_order) VALUES ('pg:retirement_apv', 'portfolio_group', 'retirement_apv', 12);
INSERT INTO benchmarks (slug, kind, portfolio_group_slug, sort_order) VALUES ('pg:brokerage_crypto', 'portfolio_group', 'brokerage_crypto', 13);
