-- Receipts payment processors mailed (payment.processor_receipts): who a charge that names only the
-- processor («PAGOS.FLOW.CL (WEB)», «PAGO FACIL») actually paid, and for what. Which expense line a
-- receipt describes is derived when the lines are built (card line ids change on re-import).

CREATE TABLE IF NOT EXISTS payment_processor_receipts (
  message_id TEXT PRIMARY KEY,
  processor TEXT NOT NULL,
  sent_at_chile TEXT NOT NULL,
  paid_at_chile TEXT NOT NULL,
  payee_name TEXT NOT NULL,
  payee_rut TEXT,
  payee_email TEXT,
  amount REAL NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (currency IN ('clp')),
  order_ref TEXT,
  concept TEXT,
  statement_descriptor TEXT,
  payment_method TEXT,
  installments INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payment_processor_receipts_paid ON payment_processor_receipts (paid_at_chile);
