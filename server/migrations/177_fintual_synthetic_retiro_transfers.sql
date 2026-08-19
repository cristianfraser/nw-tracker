-- Synthetic Fintual retiro transfers: «Pagamos tu retiro» e-mails written straight into the
-- ledger as a goal → checking transfer BEFORE the bank listed the credit (fintualEmailImport).
-- One row per synthesis, keyed by the mail's message id. The checking importers stamp
-- confirmed_on when the bank's own listing of the credit arrives and is skipped as
-- superseded_by_transfer (checkingPartialMovementsImport / checkingCartolaImport) — that skip
-- inserts nothing, so the stamp is the only trace the bank ever showed the money. A row still
-- unconfirmed past the posting window means the promised wire never appeared in any bank feed;
-- import:fintual-emails alerts on those, because a phantom credit would otherwise be silently
-- absorbed into the next checking-anchor re-derivation instead of failing loudly.
CREATE TABLE fintual_synthetic_retiro_transfers (
  movement_id INTEGER PRIMARY KEY REFERENCES movements(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE,
  amount_clp REAL NOT NULL,
  paid_on TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_on TEXT,
  confirmed_source TEXT CHECK (confirmed_source IN ('ultimos_xlsx', 'cartola')),
  CHECK ((confirmed_on IS NULL) = (confirmed_source IS NULL))
);
