-- Billing closes the bank states outside the statement lines (2026-09-26).
--
-- Until now the app knew a facturación's close only once its statement PDF (or the statement
-- JSON) was imported. Before that the open month used the card config's tentative 21-to-20
-- cycle, although the bank publishes the real close twice, well ahead of it:
--
--   next_period_from / next_period_to on cc_statements: every current statement prints the
--   following cycle («PRÓXIMO PERÍODO DE FACTURACIÓN 25/08/2026 24/09/2026» on Santander since
--   June 2026, «Próximo Período de Facturación 27/08/2026 26/09/2026» on BCI Lider), and the
--   Santander statement JSON carries the same close as FechaProxFact. Stored DD/MM/YYYY like
--   period_from / period_to. The gap between a statement's period_to and its next_period_from is
--   the issuer's close-day rule (Santander starts the next cycle ON the close day, BCI the day
--   after).
--
--   cc_feed_billing_closes: the unbilled-movements feed always opens with a SALDO INICIAL row
--   dated at the latest close and valued at that facturación's «Monto total facturado» (one row
--   per currency). It is observed the morning after the close, days before the statement
--   arrives, so the app can close the month provisionally and route every row the post-close
--   feed lists into the next facturación. The statement stays the final word and is
--   cross-checked against it on import. Amounts are debt-positive in each currency.
ALTER TABLE cc_statements ADD COLUMN next_period_from TEXT;
ALTER TABLE cc_statements ADD COLUMN next_period_to TEXT;

CREATE TABLE cc_feed_billing_closes (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  billing_month TEXT NOT NULL CHECK (billing_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  close_date TEXT NOT NULL CHECK (close_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  saldo_inicial_clp REAL,
  saldo_inicial_usd REAL,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  source_file TEXT,
  UNIQUE (account_id, billing_month)
);
