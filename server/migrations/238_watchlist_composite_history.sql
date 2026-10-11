-- The Risky Norris proxy basket, kept per Fintual positions date. `watchlist_composite_meta` /
-- `_holdings` hold only the latest basket (delete + insert on every sync), so until now nothing
-- recorded which ETFs left or entered, or when. One row per (bucket, positions date), write-once:
-- a later sync that states other weights for the same positions date is a conflict, reported and
-- never written over. `source` says where the row came from: `sync` (the evening sync, from the
-- Fintual response) or `snapshot` (recovered from a DB snapshot's holdings table; its
-- `etf_weight_sum` is the sync log's one-decimal figure, or null when no log line names the date).
CREATE TABLE IF NOT EXISTS watchlist_composite_positions (
  bucket_slug TEXT NOT NULL,
  positions_date TEXT NOT NULL,
  etf_weight_sum REAL,
  source TEXT NOT NULL CHECK (source IN ('sync', 'snapshot')),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bucket_slug, positions_date)
);

CREATE TABLE IF NOT EXISTS watchlist_composite_position_holdings (
  bucket_slug TEXT NOT NULL,
  positions_date TEXT NOT NULL,
  ticker TEXT NOT NULL,
  weight REAL NOT NULL,
  PRIMARY KEY (bucket_slug, positions_date, ticker),
  FOREIGN KEY (bucket_slug, positions_date)
    REFERENCES watchlist_composite_positions(bucket_slug, positions_date) ON DELETE CASCADE
);
