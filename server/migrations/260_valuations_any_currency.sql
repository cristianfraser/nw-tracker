-- `valuations` in any currency (docs/holdings-currency-plan.md, phase 6): a stored valuation is a
-- quantity of what the account holds, in the currency it is stated in — `currency` takes any
-- lowercase currency code ('clp', 'usd', 'uf', 'eur', …), no longer only clp / usd. The table is
-- rebuilt (SQLite cannot drop a CHECK) — nothing references it, so foreign keys stay on.
--
-- The post-migration hook (`valuationsAnyCurrency260.ts`) moves the property appraisals of
-- migration 258 (`property_appraisals`, UF) into `valuations` as the property account's rows —
-- replacing its peso rows, which nothing reads as its value (the depto ledger values it) — drops
-- `property_appraisals` and re-installs the mark-input triggers the rebuild dropped.

CREATE TABLE valuations_260 (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  as_of_date TEXT NOT NULL,
  value REAL NOT NULL,
  units_snapshot REAL,
  currency TEXT NOT NULL DEFAULT 'clp' CHECK (
    length(currency) BETWEEN 2 AND 8 AND currency NOT GLOB '*[^a-z]*'
  ),
  UNIQUE(account_id, as_of_date)
);

INSERT INTO valuations_260 (id, account_id, as_of_date, value, units_snapshot, currency)
  SELECT id, account_id, as_of_date, value, units_snapshot, currency FROM valuations;

DROP TABLE valuations;

ALTER TABLE valuations_260 RENAME TO valuations;
