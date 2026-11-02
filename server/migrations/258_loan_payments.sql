-- The depto mortgage ledger in currency-generic columns (docs/holdings-currency-plan.md, phase 4).
-- `loan_payments` replaces `depto_payments`: one row per payment movement (`leg` = the account the
-- movement sits on — 'property' for the property account's row, 'loan' for the mortgage's), what
-- the bank states in the currency it states it: the balance after the payment and the minimum /
-- maximum payment in `loan_currency` (UF), the parts of the charge in `payment_currency` (pesos).
-- The parts' UF figures, the payment's UF and the net-equity / cumulative figures are derived
-- when read (`deptoLedgerFromMovements.ts`), never stored.
--
-- `property_appraisals` holds the property's appraisal (the old `valor_vivienda_uf`), one row per
-- payment day the ledger carried it on. It is a valuation of the property account in UF, and it sits
-- in its own table until the `valuations` readers stop assuming pesos (the plan's phases 2–3).
--
-- The post-migration hook (`loanPayments258.ts`) copies the rows, checks them and drops
-- `depto_payments`.

CREATE TABLE loan_payments (
  movement_id INTEGER PRIMARY KEY REFERENCES movements(id) ON DELETE CASCADE,
  loan_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  leg TEXT NOT NULL CHECK (leg IN ('property', 'loan')),
  origin TEXT NOT NULL CHECK (origin IN ('import', 'manual')),
  cuota TEXT NOT NULL,
  loan_currency TEXT NOT NULL CHECK (loan_currency IN ('clp', 'usd', 'eur', 'uf')),
  balance_after REAL,
  min_payment REAL,
  max_payment REAL,
  payment_currency TEXT NOT NULL CHECK (payment_currency IN ('clp', 'usd', 'eur', 'uf')),
  principal REAL,
  extra_principal REAL,
  interest REAL,
  insurance_fire REAL,
  insurance_life REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_loan_payments_loan_account ON loan_payments (loan_account_id);

CREATE TABLE property_appraisals (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  as_of_date TEXT NOT NULL,
  value REAL NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('clp', 'usd', 'eur', 'uf')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, as_of_date)
);
