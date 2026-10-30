-- The job queue (docs/job-queue-plan.md): every long-running job of the primary server — the
-- ingest runs, a deploy, later maintenance scripts — is a row here. Producers enqueue; one
-- executor in the server decides what may start from the resources each job holds while running
-- (`resources_json`), never from clock windows; workers claim, heartbeat and complete. A job
-- that cannot start yet waits (and runs late); it is never dropped.
--   dedupe_key: at most one QUEUED job per key (partial unique index) — enqueuing it again
--     updates that row (a second push moves a waiting deploy's target sha; a new hourly slot is
--     absorbed by the hourly still queued). A running job is never modified.
--   not_before: earliest start; stale_after: from then on the job is superseded, not run.
--   heartbeat_at + lease_ms: a running job whose worker went silent for its lease is `lost`.
-- Instants are ISO UTC strings (`toISOString()`), so they compare as text.
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  dedupe_key TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled', 'superseded', 'lost')),
  priority INTEGER NOT NULL DEFAULT 0,
  not_before TEXT,
  stale_after TEXT,
  resources_json TEXT NOT NULL DEFAULT '[]',
  worker TEXT,
  claimed_at TEXT,
  heartbeat_at TEXT,
  lease_ms INTEGER NOT NULL CHECK (lease_ms > 0),
  attempt INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  enqueued_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE UNIQUE INDEX jobs_queued_dedupe ON jobs (dedupe_key) WHERE status = 'queued' AND dedupe_key IS NOT NULL;
CREATE INDEX jobs_status ON jobs (status);
-- An ingest run is the detail of the job that ran it (null for runs from before the queue).
ALTER TABLE ingest_runs ADD COLUMN job_id INTEGER REFERENCES jobs (id);
