-- (Numbered 211: an unfinished draft of this migration ran on the live database as
-- `210_mark_input_changes.sql`, beside the unrelated `210_market_symbols.sql`. IF NOT EXISTS keeps
-- that table; the hook replaces the draft's triggers.)
-- What changed in the inputs of the per-account daily marks: one row per changed input row,
-- naming the table, the account (null: an input every account can read — prices, fx, UF, fund
-- units, the nav tree) and the raw date of the change. Filled by triggers (created by this
-- migration's hook in db.ts: `markInputChangeTriggers211.ts`, since migration SQL cannot hold
-- trigger bodies) and read by `markInputChanges.ts`, which turns each row into "keep this
-- account's cached marks before date X" (per-table rules: a card's dollar lines read the fx of
-- their pay-by, so an fx row reaches back further for cards, and so on).
CREATE TABLE IF NOT EXISTS mark_input_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  account_id INTEGER,
  raw_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mark_input_changes_created ON mark_input_changes (created_at);
