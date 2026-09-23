-- Learned boleta branch → bank merchant map, and each receipt's card-line state (2026-09-23).
--
-- A receipt paid with a chain's co-branded card becomes an open-month card line only when the
-- printed branch («SUC:» header) maps to the bank's exact merchant string for that store — the
-- dedupe key the feed/statement will print. Until now that map lived only in the hand-declared
-- registry (cc-cards.json `boleta_sucursal_merchants`), so the FIRST receipt from any new store
-- had no line and the importer could only report it; on 2026-09-20 (Hiper Lider Ficticio)
-- that log line went unnoticed for three nights while a hand-paste of the same purchase went
-- in unpaired.
--
-- Now the receipt is FLAGGED (`card_line_status = 'pending_branch'`, the card master it would
-- have written to in `card_line_account_id`) and the bank's own line for the same day and the
-- same pesos on that card — whichever source writes it: the paste textarea, the nightly feed or
-- the statement PDF — pairs with it inside the shared card-write funnel. The pairing LEARNS the
-- mapping here (statement convention, « (T)» stripped) and marks the receipt `matched`; the
-- next receipt at that store carries its own line through the normal path. `source` says who
-- declared the row; the learned_* columns are the evidence (SET NULL when the open-bucket line
-- is later superseded by the statement — the mapping outlives the line).
--
-- card_line_status: NULL = no card-line outcome recorded (not card-paid, closed month, chain
-- without a card rule, or imported before this migration); 'created' = the importer wrote the
-- line; 'covered' = an existing line already carried the purchase (duplicate / same-day-amount);
-- 'pending_branch' = flagged, waiting for the bank's line; 'matched' = paired and learned.
ALTER TABLE grocery_receipts ADD COLUMN card_line_status TEXT
  CHECK (card_line_status IS NULL OR card_line_status IN ('created', 'covered', 'pending_branch', 'matched'));
ALTER TABLE grocery_receipts ADD COLUMN card_line_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
CREATE INDEX idx_grocery_receipts_card_line ON grocery_receipts(card_line_account_id, card_line_status);

CREATE TABLE grocery_branch_merchants (
  id INTEGER PRIMARY KEY,
  store_chain TEXT NOT NULL,
  -- The printed branch string exactly as the receipt prints it (each rendering is its own key).
  branch TEXT NOT NULL,
  -- The bank's merchant string, statement convention (no « (T)» suffix).
  merchant TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('learned', 'manual')),
  learned_receipt_id INTEGER REFERENCES grocery_receipts(id) ON DELETE SET NULL,
  learned_statement_line_id INTEGER REFERENCES cc_statement_lines(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (store_chain, branch)
);
