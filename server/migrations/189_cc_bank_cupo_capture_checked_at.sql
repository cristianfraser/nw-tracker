-- The bank cupo check reports each capture once (2026-09-27): checked_at marks the capture a run of
-- `check:cc-bank-cupo` has reported, so a rerun of the step (the nightly after the hourly catch-up,
-- or a fetch that failed and left the same latest capture) raises nothing new.
ALTER TABLE cc_bank_cupo_captures ADD COLUMN checked_at TEXT;
