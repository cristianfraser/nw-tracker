-- A refund the Tesorería kept to pay another year's tax debt («compensación»): no money reaches an
-- account, so an `offset` row names no account; it is stored once, under the refund's tax year, and
-- names the year whose debt it paid (`offset_tax_year`), which reads it as a payment.
CREATE TABLE f22_settlements_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tax_year INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('refund', 'payment', 'offset')),
  account_id INTEGER REFERENCES accounts(id),
  movement_id INTEGER REFERENCES movements(id) ON DELETE RESTRICT,
  offset_tax_year INTEGER,
  occurred_on TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount > 0),
  description TEXT NOT NULL,
  CHECK (
    (kind = 'offset' AND account_id IS NULL AND movement_id IS NULL AND offset_tax_year IS NOT NULL AND offset_tax_year <> tax_year)
    OR (kind <> 'offset' AND account_id IS NOT NULL AND offset_tax_year IS NULL)
  )
);
INSERT INTO f22_settlements_new (id, tax_year, kind, account_id, movement_id, offset_tax_year, occurred_on, amount, description)
  SELECT id, tax_year, kind, account_id, movement_id, NULL, occurred_on, amount, description FROM f22_settlements;
DROP TABLE f22_settlements;
ALTER TABLE f22_settlements_new RENAME TO f22_settlements;
CREATE UNIQUE INDEX f22_settlements_identity
  ON f22_settlements (tax_year, kind, COALESCE(account_id, 0), COALESCE(offset_tax_year, 0), occurred_on, amount);
