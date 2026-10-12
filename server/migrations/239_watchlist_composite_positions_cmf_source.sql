-- The basket history takes a third source: `cmf`, the regulator's monthly portfolio file
-- (Comisión para el Mercado Financiero, «Cartera de inversiones extranjeras» per fondo mutuo),
-- which names every holding of the fund with its share of fund assets, monthly since the fund's
-- first month — the only record of the basket before the sync existed. Rebuilt with foreign keys
-- off (db.ts FOREIGN_KEYS_OFF_MIGRATIONS): watchlist_composite_position_holdings references it.
CREATE TABLE watchlist_composite_positions_new (
  bucket_slug TEXT NOT NULL,
  positions_date TEXT NOT NULL,
  etf_weight_sum REAL,
  source TEXT NOT NULL CHECK (source IN ('sync', 'snapshot', 'cmf')),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bucket_slug, positions_date)
);
INSERT INTO watchlist_composite_positions_new (bucket_slug, positions_date, etf_weight_sum, source, recorded_at)
  SELECT bucket_slug, positions_date, etf_weight_sum, source, recorded_at FROM watchlist_composite_positions;
DROP TABLE watchlist_composite_positions;
ALTER TABLE watchlist_composite_positions_new RENAME TO watchlist_composite_positions;
