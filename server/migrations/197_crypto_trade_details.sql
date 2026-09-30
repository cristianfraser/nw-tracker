-- The exchange's own record of each crypto trade: what was traded, at what price and for what
-- commission (the Buda import had modeled commissions with a fixed rate). The SII does not let a
-- commission reduce a crypto gain (Oficio 2208/2022), so the tax lots need it per trade: a
-- purchase's cost excludes it, a sale's price includes it. One row per crypto movement of kind
-- buy / sell / swap_in, written by server/scripts/import-buda-trade-details.ts.
CREATE TABLE IF NOT EXISTS crypto_trade_details (
  movement_id INTEGER PRIMARY KEY REFERENCES movements(id) ON DELETE CASCADE,
  exchange_trade_id TEXT NOT NULL UNIQUE,
  units REAL NOT NULL CHECK (units > 0),
  price REAL NOT NULL CHECK (price > 0),
  price_currency TEXT NOT NULL CHECK (price_currency IN ('clp', 'btc')),
  fee_amount REAL NOT NULL CHECK (fee_amount >= 0),
  fee_currency TEXT NOT NULL CHECK (fee_currency IN ('clp', 'btc', 'eth')),
  created_at TEXT NOT NULL
);
