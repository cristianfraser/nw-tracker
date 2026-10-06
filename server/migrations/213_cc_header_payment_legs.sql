-- The legs of a statement's header payment («monto pagado período anterior») that the statement
-- prints without a date: the parser dates a header only when exactly one body line carries it, so a
-- period paid in several transfers, or by a debit the card printed no line for, has none. A leg
-- names one payment of that header with its day and pesos (the bank debit that paid it), so the
-- card-payment pairing and the cuota retirement read it like a dated payment.
-- Keyed by card + close date, not the statement row: a re-import replaces statement rows.
CREATE TABLE IF NOT EXISTS cc_header_payment_legs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  statement_close_iso TEXT NOT NULL,
  paid_on TEXT NOT NULL,
  amount_clp INTEGER NOT NULL CHECK (amount_clp > 0),
  -- bank_debit: the checking debit that paid it (paired as a pago_tarjeta transfer)
  -- pay_by: no bank record survives (the 2019-07..12 cartolas are lost), dated at the pay-by
  source TEXT NOT NULL CHECK (source IN ('bank_debit', 'pay_by')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, statement_close_iso, paid_on, amount_clp)
);

CREATE INDEX IF NOT EXISTS idx_cc_header_payment_legs_account
  ON cc_header_payment_legs (account_id, paid_on);
