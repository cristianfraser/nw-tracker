-- Card listings from a second issuer (the Lider BCI card's unbilled listing, `card.unbilled_movements`
-- naming the card by its plastic's last4).
--
-- Each cupo capture names the issuer whose session observed it: the check judges every issuer's
-- latest capture on its own, so two banks posting captures hourly cannot hide each other's. Every
-- capture on file is Santander's (the only issuer that reported one).
ALTER TABLE cc_bank_cupo_captures ADD COLUMN issuer TEXT NOT NULL DEFAULT 'santander';
CREATE INDEX idx_cc_bank_cupo_captures_issuer ON cc_bank_cupo_captures(issuer, id);

-- The PAGO the facturado-financing matcher plants on a paid card (batch kind `cc_financing_payment`)
-- is a planted payment like a receipt's or a hand-entered one: the bank's own listing of it, under
-- whatever wording and a few days later, replaces it (`ccPlantedPayments.ts`). The table is
-- rebuilt for the wider `source` check; nothing references it.
CREATE TABLE cc_planted_payment_lines_new (
  line_id INTEGER PRIMARY KEY REFERENCES cc_statement_lines(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('cc_santander_receipt', 'cc_manual_payment', 'cc_financing_payment')),
  currency TEXT NOT NULL REFERENCES currencies(code),
  amount REAL NOT NULL CHECK (amount > 0),
  paid_on TEXT NOT NULL CHECK (paid_on GLOB '????-??-??'),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO cc_planted_payment_lines_new (line_id, account_id, source, currency, amount, paid_on, created_at)
  SELECT line_id, account_id, source, currency, amount, paid_on, created_at FROM cc_planted_payment_lines;
DROP TABLE cc_planted_payment_lines;
ALTER TABLE cc_planted_payment_lines_new RENAME TO cc_planted_payment_lines;
CREATE INDEX idx_cc_planted_payment_lines_account ON cc_planted_payment_lines(account_id);
