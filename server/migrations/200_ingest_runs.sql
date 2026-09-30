-- Runs the server's scheduler asked the ingest service for (docs/ingest-split-plan.md, Phase 2).
-- One row per (kind, slot): the 22:00 nightly slot or the :30 hourly slot it answers, as the UTC
-- instant of that slot. A row is the scheduler's memory of a slot being handled — requested,
-- finished, skipped (a repeat right behind another run, or the feeder busy with the nightly) —
-- so a restart or a wake never runs a slot twice. `not_started`: the service did not take it
-- (down, or busy with a run started by hand); a nightly slot keeps being retried, an hourly one
-- is given up. `lost`: taken, but no report came back in time.
CREATE TABLE ingest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('nightly', 'hourly')),
  slot_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested', 'done', 'failed', 'lost', 'skipped', 'not_started')),
  reason TEXT NOT NULL,
  requested_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,
  failed_steps INTEGER,
  steps_json TEXT,
  error TEXT,
  UNIQUE (kind, slot_at)
);
