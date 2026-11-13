-- Lider BCI's card site in the ingest runs (`fetch:lider-bci` + `import:lider-movements`):
--   lider_request / _reason: the read the server asked an hourly poll for (`lider_fetch`); the
--     nightly always reads the site and asks nothing.
--   lider_outcome / lider_note: what became of the run's read (ok | failed | turnstile | vetoed).
--   lider_state_json: the feeder's Lider facts when the run ended (last attempt, last success,
--     the latch standing), which the scheduler decides the next hourly read from.
ALTER TABLE ingest_runs ADD COLUMN lider_request TEXT CHECK (lider_request IN ('poll'));
ALTER TABLE ingest_runs ADD COLUMN lider_request_reason TEXT;
ALTER TABLE ingest_runs ADD COLUMN lider_outcome TEXT CHECK (lider_outcome IN ('ok', 'failed', 'turnstile', 'vetoed'));
ALTER TABLE ingest_runs ADD COLUMN lider_note TEXT;
ALTER TABLE ingest_runs ADD COLUMN lider_state_json TEXT;
