-- Credits written from an incoming transfer's mail (bank_account.transfer_notices) before any bank
-- feed lists them: the money is in the account the moment the mail says so, and the 22:00 feed
-- only confirms it. One row per notice, kept when its movement is deleted (movement_id goes NULL),
-- so a credit someone removed by hand is never written again. The checking importers skip the
-- bank's own listing of the money and stamp it here: the bank's day (also the movement's posting
-- day) and its description.

CREATE TABLE IF NOT EXISTS transfer_notice_credits (
  message_id TEXT PRIMARY KEY REFERENCES bank_transfer_notices(message_id),
  movement_id INTEGER UNIQUE REFERENCES movements(id) ON DELETE SET NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  notice_date TEXT NOT NULL,
  confirmed_on TEXT,
  confirmed_source TEXT CHECK (confirmed_source IN ('ultimos_xlsx', 'cartola')),
  bank_description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transfer_notice_credits_account ON transfer_notice_credits (account_id, amount);
