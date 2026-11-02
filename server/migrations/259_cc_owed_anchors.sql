-- A credit card's walk anchors, per currency (docs/holdings-cards-plan.md): what the card owed on
-- the date in each currency it is billed in (pesos, dollars to the cent). valuations keeps one CLP
-- row per anchor date = the value converted at that date's rate.
CREATE TABLE IF NOT EXISTS cc_owed_anchors (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  as_of_date TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('clp', 'usd')),
  amount REAL NOT NULL,
  PRIMARY KEY (account_id, as_of_date, currency)
);
