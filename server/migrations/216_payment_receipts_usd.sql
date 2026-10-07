-- A shop's order confirmation may be in dollars (DynaVap charges the card's dollar side):
-- payment_processor_receipts.currency allows 'usd'. Pesos stay whole, dollars to the cent.

CREATE TABLE payment_processor_receipts_new (
  message_id TEXT PRIMARY KEY,
  processor TEXT NOT NULL,
  sent_at_chile TEXT NOT NULL,
  paid_at_chile TEXT NOT NULL,
  payee_name TEXT NOT NULL,
  payee_rut TEXT,
  payee_email TEXT,
  amount REAL NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (currency IN ('clp', 'usd')),
  order_ref TEXT,
  concept TEXT,
  statement_descriptor TEXT,
  payment_method TEXT,
  installments INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO payment_processor_receipts_new SELECT * FROM payment_processor_receipts;

DROP TABLE payment_processor_receipts;

ALTER TABLE payment_processor_receipts_new RENAME TO payment_processor_receipts;

CREATE INDEX IF NOT EXISTS idx_payment_processor_receipts_paid ON payment_processor_receipts (paid_at_chile);
