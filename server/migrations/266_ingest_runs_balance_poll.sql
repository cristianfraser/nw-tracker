-- The hourly poll's bank fetch is now the balance poll (log in, compare the product summary with
-- the app, read the movements of the products that disagree). The catch-up and payday fetches are
-- retired. SQLite cannot change a column's CHECK, so the table is rebuilt, and past rows keep their
-- catch-up | payday requests. Nothing references ingest_runs.
CREATE TABLE ingest_runs_new (
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
  santander_request TEXT CHECK (santander_request IN ('balance-poll', 'catch-up', 'payday')),
  santander_request_reason TEXT,
  santander_outcome TEXT CHECK (santander_outcome IN ('ok', 'failed', 'vetoed')),
  santander_note TEXT,
  santander_state_json TEXT,
  activity INTEGER,
  dry_run INTEGER,
  job_id INTEGER REFERENCES jobs (id),
  UNIQUE (kind, slot_at)
);
INSERT INTO ingest_runs_new (
  id, kind, slot_at, status, reason, requested_at, started_at, finished_at, exit_code, failed_steps,
  steps_json, error, santander_request, santander_request_reason, santander_outcome, santander_note,
  santander_state_json, activity, dry_run, job_id
)
SELECT
  id, kind, slot_at, status, reason, requested_at, started_at, finished_at, exit_code, failed_steps,
  steps_json, error, santander_request, santander_request_reason, santander_outcome, santander_note,
  santander_state_json, activity, dry_run, job_id
FROM ingest_runs;
DROP TABLE ingest_runs;
ALTER TABLE ingest_runs_new RENAME TO ingest_runs;
