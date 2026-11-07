-- The change log becomes the caches' only write signal (docs/untangle-plan.md F2). Mark rows keep
-- naming an account and a date (`kind = 'mark'`); write rows name a table alone (`kind = 'write'`),
-- logged by write triggers on every table the caches read, so a write drops exactly the cache
-- families that read its table, from whichever connection it came. The hook (`markInputTriggers.ts`,
-- `runMarkInputChangeTriggers270`) adds mark triggers on the four card tables migration 211 left out
-- (cc_owed_anchors, cc_header_payment_legs, cc_feed_billing_closes, credit_card_account_config) and
-- installs the write triggers.
ALTER TABLE mark_input_changes ADD COLUMN kind TEXT NOT NULL DEFAULT 'mark' CHECK (kind IN ('mark', 'write'));
