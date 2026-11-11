-- A mortgage lender's receipt for one cuota paid online (`mortgage.payment_receipt` v1; MetLife
-- Hipotecario's «Pago de dividendo realizado» mail). Stored once per (lender, transaction id); a
-- resend stating other fields is a conflict. The cuota is charged to a card with no daily feed
-- (BCI Lider), so the apply also plants that charge in the card's open web-paste bucket, which the
-- card's statement settles when it prints the same charge. `card_account_id` is the card master the
-- feeder named; `message_id` is the mail's (provenance, not compared). The write-log triggers are
-- added by the migration's hook (`mortgagePaymentReceipts307.ts`).
CREATE TABLE IF NOT EXISTS mortgage_payment_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lender TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  paid_on TEXT NOT NULL CHECK (paid_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  amount_clp INTEGER NOT NULL CHECK (amount_clp > 0),
  credit_number TEXT NOT NULL,
  dividend_number TEXT NOT NULL,
  due_on TEXT NOT NULL CHECK (due_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  card_account_id INTEGER NOT NULL REFERENCES accounts(id),
  message_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (lender, transaction_id)
);
