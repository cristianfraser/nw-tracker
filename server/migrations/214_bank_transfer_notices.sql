-- Transfers the bank mailed about (bank_account.transfer_notices): each notice as the mail states
-- it, and which bank movement it describes, so a transfer shows who it went to or came from.

CREATE TABLE IF NOT EXISTS bank_transfer_notices (
  message_id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  sent_at_chile TEXT NOT NULL,
  subject TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('outgoing', 'incoming', 'between_own_products', 'schedule_created')),
  notice_date TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  scheduled INTEGER NOT NULL CHECK (scheduled IN (0, 1)),
  comment TEXT,
  from_name TEXT, from_rut TEXT, from_bank TEXT, from_account_type TEXT, from_account_number TEXT, from_email TEXT,
  to_name TEXT, to_rut TEXT, to_bank TEXT, to_account_type TEXT, to_account_number TEXT, to_email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bank_transfer_notices_sent ON bank_transfer_notices (sent_at_chile);

-- One row per (movement, account side): the notice that describes that bank movement. Derived:
-- rebuilt from every stored notice on each apply.
CREATE TABLE IF NOT EXISTS movement_transfer_notices (
  movement_id INTEGER NOT NULL REFERENCES movements(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES bank_transfer_notices(message_id) ON DELETE CASCADE,
  PRIMARY KEY (movement_id, account_id),
  UNIQUE (message_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_movement_transfer_notices_message ON movement_transfer_notices (message_id);

-- Which app account a transfer counterparty is, by its RUT or its account number (personal data:
-- set on the live database only). A notice whose counterparty maps here pairs, among same-day
-- candidates, with the transfer to or from that account: a payment to the fund manager with the
-- transfer into the fund, not with a same-day, same-amount payment to someone else.
CREATE TABLE IF NOT EXISTS transfer_counterparty_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rut TEXT,
  account_number TEXT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  CHECK ((rut IS NULL) <> (account_number IS NULL)),
  UNIQUE (rut, account_number, account_id)
);
