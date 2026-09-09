-- Synthetic Santander card-payment transfers: a «Pago Deuda Nacional TCR» / «Comprobante Pago
-- (abono) de la deuda facturada en dolares» receipt mail written straight into the ledger as the
-- checking → card `pago_tarjeta` transfer BEFORE the bank feed listed the checking debit
-- (santanderCcPaymentReceipts). Twin of fintual_synthetic_retiro_transfers (migration 177): one
-- row per synthesis, keyed by the mail's message id; the checking importers stamp confirmed_on
-- when the bank's own listing of the debit arrives and is skipped as superseded_by_transfer —
-- that skip inserts nothing, so the stamp is the only trace the bank ever moved the money, and
-- import:santander-receipts alerts on a row still unconfirmed past the posting window.
CREATE TABLE santander_synthetic_cc_payment_transfers (
  movement_id INTEGER PRIMARY KEY REFERENCES movements(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE,
  amount_clp REAL NOT NULL,
  paid_on TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_on TEXT,
  confirmed_source TEXT CHECK (confirmed_source IN ('ultimos_xlsx', 'cartola')),
  CHECK ((confirmed_on IS NULL) = (confirmed_source IS NULL))
)
