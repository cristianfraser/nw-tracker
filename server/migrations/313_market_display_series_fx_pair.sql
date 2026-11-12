-- The watchlist, the marquee and the rates page show any currency pair as a rate row (2026-11-12):
-- kind `fx_pair`, its `series_key` naming the pair as `<base>_<quote>` (`eur_usd`, `eur_clp`), the
-- rate read through `rates.ts`. USD/CLP keeps its own kind, `fx_usd` (the live CLP=X row). The
-- kind list is a CHECK, so the table is rebuilt. No foreign key references it, so foreign keys
-- stay ON; the dropped table takes its write-log triggers with it, which the hook
-- `runMarketDisplaySeriesFxPair313` re-creates.
CREATE TABLE market_display_series_new (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  label_i18n_key TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL CHECK (kind IN ('equity', 'fund_unit', 'fx_usd', 'fx_pair', 'uf', 'composite')),
  series_key TEXT,
  show_in_marquee INTEGER NOT NULL DEFAULT 0 CHECK (show_in_marquee IN (0, 1)),
  show_in_rates INTEGER NOT NULL DEFAULT 0 CHECK (show_in_rates IN (0, 1)),
  rates_chart_title TEXT,
  source TEXT NOT NULL DEFAULT 'builtin' CHECK (source IN ('builtin', 'account', 'manual'))
);
INSERT INTO market_display_series_new (id, slug, label, label_i18n_key, sort_order, kind, series_key, show_in_marquee, show_in_rates, rates_chart_title, source)
SELECT id, slug, label, label_i18n_key, sort_order, kind, series_key, show_in_marquee, show_in_rates, rates_chart_title, source FROM market_display_series;
DROP TABLE market_display_series;
ALTER TABLE market_display_series_new RENAME TO market_display_series;
