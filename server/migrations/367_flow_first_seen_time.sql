-- When a flow first reached the ledger, to the moment (`first_seen_at`, UTC ISO) and in write order
-- (`first_seen_seq`, one counter over the table: a nightly listing writes many rows in one second).
-- Written by the card-line insert, the movement insert and the manual-expense create
-- (`flows/flowFirstSeen.ts`); the home «Últimos movimientos» orders a day's rows by it, newest
-- write first. Carried like the day through merges and re-imports. Forward only: rows of migration
-- 310 keep their day and no time. The hook reinstalls the write-log update trigger with the new
-- columns.
ALTER TABLE flow_first_seen ADD COLUMN first_seen_at TEXT;
ALTER TABLE flow_first_seen ADD COLUMN first_seen_seq INTEGER;
CREATE INDEX IF NOT EXISTS flow_first_seen_seq ON flow_first_seen(first_seen_seq);
