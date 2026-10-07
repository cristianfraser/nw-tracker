-- Movements written from a transfer mail, both ways: an incoming transfer's credit (219) and now a
-- payment to a third party's debit (Santander's own receipts). The amount is signed for the
-- checking account (+ in, − out); 219's credits keep their sign. Renamed from
-- transfer_notice_credits.

CREATE TABLE IF NOT EXISTS transfer_notice_movements (
  message_id TEXT PRIMARY KEY REFERENCES bank_transfer_notices(message_id),
  movement_id INTEGER UNIQUE REFERENCES movements(id) ON DELETE SET NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  amount INTEGER NOT NULL CHECK (amount <> 0),
  notice_date TEXT NOT NULL,
  confirmed_on TEXT,
  confirmed_source TEXT CHECK (confirmed_source IN ('ultimos_xlsx', 'cartola')),
  bank_description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO transfer_notice_movements
  (message_id, movement_id, account_id, amount, notice_date, confirmed_on, confirmed_source, bank_description, created_at)
SELECT message_id, movement_id, account_id, amount, notice_date, confirmed_on, confirmed_source, bank_description, created_at
FROM transfer_notice_credits;

DROP TABLE transfer_notice_credits;

CREATE INDEX IF NOT EXISTS idx_transfer_notice_movements_account ON transfer_notice_movements (account_id, amount);
