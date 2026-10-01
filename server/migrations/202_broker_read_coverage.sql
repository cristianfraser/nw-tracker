-- How far a broker's movement list has been read and applied with nothing to fix
-- (docs/ingest-split-plan.md, Phase 3 source 4). Replaces `clean_crawl_at` in
-- cfraser/.racional-import-state.json: a notification sent before `clean_through` is answered
-- by a read, so it no longer asks for the browser. Forward-only; one row per broker.
CREATE TABLE broker_read_coverage (
  broker TEXT PRIMARY KEY CHECK (broker IN ('racional')),
  clean_through TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
