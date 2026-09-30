-- The runs move to the TypeScript runners (docs/ingest-split-plan.md, Phase 2b): the server now
-- decides an hourly poll's bank fetch (the catch-up after a failed nightly fetch, the payday
-- morning fetch) and records each run's app message from its report.
--   santander_request / _reason: the fetch the server asked the poll for (catch-up | payday).
--   santander_outcome / _note: what the run reports of its bank fetch (the nightly's own
--     included): ok | failed | vetoed (the feeder declined: login latched, bank tried moments ago).
--   santander_state_json: the feeder's bank facts when the run ended (last attempt, last
--     successful fetch, login latched) — what the next decision reads.
--   activity / dry_run: as reported; a dry run is never recorded.
ALTER TABLE ingest_runs ADD COLUMN santander_request TEXT CHECK (santander_request IN ('catch-up', 'payday'));
ALTER TABLE ingest_runs ADD COLUMN santander_request_reason TEXT;
ALTER TABLE ingest_runs ADD COLUMN santander_outcome TEXT CHECK (santander_outcome IN ('ok', 'failed', 'vetoed'));
ALTER TABLE ingest_runs ADD COLUMN santander_note TEXT;
ALTER TABLE ingest_runs ADD COLUMN santander_state_json TEXT;
ALTER TABLE ingest_runs ADD COLUMN activity INTEGER;
ALTER TABLE ingest_runs ADD COLUMN dry_run INTEGER;
