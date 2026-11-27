-- The import-sync matrix's months that went late and were notified (`lateDocuments.ts`): one row
-- per column (account, document kind, currency) and month, written with its «Document not
-- received» notification, so a month notifies once. The row stays when the document later
-- arrives: the month is no longer missing, so it is never late again, and a document deleted
-- afterwards must not notify a second time. A cartola column's currency is the cartola's
-- (pesos); a card's is its statement column's. Machine bookkeeping: no write-log triggers.
CREATE TABLE IF NOT EXISTS late_document_notifications (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  document_kind TEXT NOT NULL CHECK (document_kind IN ('checking_cartola', 'cuenta_vista_cartola', 'cc_statement')),
  currency TEXT NOT NULL REFERENCES currencies(code),
  month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  notified_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, document_kind, currency, month)
)
