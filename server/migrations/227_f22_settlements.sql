-- How each filed Formulario 22 was settled: the Tesorería's refund credit or the tax payment, by the
-- evidence's own identity (account, day, pesos; the movement for a checking row — a card line's id
-- changes on re-import, so a card payment is found by account, day and pesos). Several rows for a
-- year paid in parts. Written by server/scripts/link-f22-settlements.ts.
CREATE TABLE f22_settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tax_year INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('refund', 'payment')),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  movement_id INTEGER REFERENCES movements(id) ON DELETE RESTRICT,
  occurred_on TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount > 0),
  description TEXT NOT NULL,
  UNIQUE (tax_year, account_id, occurred_on, amount)
);
