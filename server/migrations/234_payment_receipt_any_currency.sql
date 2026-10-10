-- payment.processor_receipts: a receipt abroad states its local currency («nzd», «eur», «brl»);
-- the card's dollar statement prints the charge's original amount beside the dollars, which is
-- what such a receipt pairs on. A lodging receipt carries its stay (check-in, check-out, city). Rebuilt with foreign keys off (db.ts FOREIGN_KEYS_OFF_MIGRATIONS):
-- payment_receipt_charges references this table, and dropping it with them on would cascade.
CREATE TABLE payment_processor_receipts_new (
  message_id TEXT PRIMARY KEY,
  processor TEXT NOT NULL,
  sent_at_chile TEXT NOT NULL,
  paid_at_chile TEXT NOT NULL,
  payee_name TEXT NOT NULL,
  payee_rut TEXT,
  payee_email TEXT,
  amount REAL CHECK (amount IS NULL OR amount > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = lower(currency)),
  order_ref TEXT,
  concept TEXT,
  statement_descriptor TEXT,
  payment_method TEXT,
  installments INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  trip_from TEXT,
  trip_to TEXT,
  trip_started_at_chile TEXT,
  trip_ended_at_chile TEXT,
  trip_distance_km REAL,
  subscription INTEGER NOT NULL DEFAULT 0 CHECK (subscription IN (0, 1)),
  stay_check_in TEXT,
  stay_check_out TEXT,
  stay_city TEXT
);

INSERT INTO payment_processor_receipts_new (message_id, processor, sent_at_chile, paid_at_chile, payee_name, payee_rut, payee_email, amount, currency, order_ref, concept, statement_descriptor, payment_method, installments, created_at, trip_from, trip_to, trip_started_at_chile, trip_ended_at_chile, trip_distance_km, subscription)
SELECT message_id, processor, sent_at_chile, paid_at_chile, payee_name, payee_rut, payee_email, amount, currency, order_ref, concept, statement_descriptor, payment_method, installments, created_at, trip_from, trip_to, trip_started_at_chile, trip_ended_at_chile, trip_distance_km, subscription FROM payment_processor_receipts;

DROP TABLE payment_processor_receipts;

ALTER TABLE payment_processor_receipts_new RENAME TO payment_processor_receipts;

CREATE INDEX IF NOT EXISTS idx_payment_processor_receipts_paid ON payment_processor_receipts (paid_at_chile);
