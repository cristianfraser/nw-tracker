-- payment.processor_receipts v3:
--  * a receipt may state no amount (MercadoLibre's purchase mails stopped printing it in 2026): it
--    still names what was bought, and pairs by its day and the charge's name instead;
--  * the separate card charges a payment was taken as: a MercadoLibre order from two sellers is
--    charged once per seller («1x $ 8.865 y 1x $ 6.860»), each possibly in cuotas. A receipt without
--    rows here is one charge of its amount.

CREATE TABLE payment_processor_receipts_new (
  message_id TEXT PRIMARY KEY,
  processor TEXT NOT NULL,
  sent_at_chile TEXT NOT NULL,
  paid_at_chile TEXT NOT NULL,
  payee_name TEXT NOT NULL,
  payee_rut TEXT,
  payee_email TEXT,
  amount REAL CHECK (amount IS NULL OR amount > 0),
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

CREATE TABLE IF NOT EXISTS payment_receipt_charges (
  message_id TEXT NOT NULL REFERENCES payment_processor_receipts(message_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 1),
  amount REAL NOT NULL CHECK (amount > 0),
  installments INTEGER CHECK (installments IS NULL OR installments >= 2),
  PRIMARY KEY (message_id, position)
);
