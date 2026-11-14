-- Card purchases the bank annulled before billing them (`ccAnnulledPurchases.ts`). A bank that voids
-- an unbilled purchase drops it from its «por facturar» listing instead of posting a refund credit;
-- the app keeps the purchase in history as two events — the purchase on its own day and its
-- annulment (a refund of the same amount) on the day the bank dropped it — instead of deleting it.
-- The open-bucket line is deleted when its row is written. `parser_row_id` is the line's: with the
-- card, merchant and purchase day it rebuilds the expense key the line carried
-- (`cards/oneShotLineKey.ts`), so the flow's category, note and big group stay reachable — the key
-- itself lives on the flow, never here.
-- `amount` is debt-positive in `currency`. `basis` names what proved the annulment: the feed no
-- longer listing it under a proof of completeness (`feed_drop`), the bank's cupo moving by exactly
-- its amount (`cupo_gap`), the statement that closed its cycle not billing it (`statement_close`),
-- or the user (`manual`). `evidence` is the source ref (feed file, statement) or null.
CREATE TABLE cc_annulled_purchases (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  currency TEXT NOT NULL REFERENCES currencies(code),
  amount REAL NOT NULL CHECK (amount > 0),
  merchant TEXT NOT NULL,
  purchase_date TEXT NOT NULL CHECK (purchase_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  annulled_on TEXT NOT NULL CHECK (annulled_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  basis TEXT NOT NULL CHECK (basis IN ('feed_drop', 'cupo_gap', 'statement_close', 'manual')),
  parser_row_id TEXT,
  flow_id INTEGER REFERENCES flows(id) ON DELETE SET NULL,
  dedupe_key TEXT,
  origin_card_last4 TEXT,
  evidence TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (annulled_on >= purchase_date)
);
CREATE INDEX idx_cc_annulled_purchases_account ON cc_annulled_purchases(account_id);
CREATE UNIQUE INDEX idx_cc_annulled_purchases_parser_row ON cc_annulled_purchases(account_id, parser_row_id)
  WHERE parser_row_id IS NOT NULL
