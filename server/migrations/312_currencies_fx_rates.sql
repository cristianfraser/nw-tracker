-- Currencies are data (2026-11-11): the codes the app knows, how they print, and where their rate
-- against the hub (USD) comes from. `core` currencies are loaded and kept current; `on_demand`
-- (later) are loaded the first time someone shows a figure in them.
CREATE TABLE currencies (
  code TEXT PRIMARY KEY CHECK (code GLOB '[a-z][a-z][a-z]' OR code = 'uf'),
  symbol TEXT NOT NULL,
  minor_digits INTEGER NOT NULL CHECK (minor_digits BETWEEN 0 AND 4),
  tier TEXT NOT NULL CHECK (tier IN ('core', 'on_demand', 'index')),
  -- The Yahoo symbol of the pair this currency is loaded from (`fx_rates`); null when its rates
  -- live in a table of their own (USD/CLP `fx_daily`, UF `uf_daily`) or it is the hub itself.
  yahoo_pair_symbol TEXT,
  pair_base TEXT,
  pair_quote TEXT,
  CHECK ((yahoo_pair_symbol IS NULL) = (pair_base IS NULL) AND (pair_base IS NULL) = (pair_quote IS NULL))
);

INSERT INTO currencies (code, symbol, minor_digits, tier, yahoo_pair_symbol, pair_base, pair_quote) VALUES
  ('usd', 'US$', 2, 'core', NULL, NULL, NULL),
  ('clp', '$', 0, 'core', NULL, NULL, NULL),
  ('eur', '€', 2, 'core', 'EURUSD=X', 'eur', 'usd'),
  ('uf', 'UF ', 4, 'index', NULL, NULL, NULL);

-- Daily rates of every pair loaded through `currencies` (quote units per one base unit), write-once
-- like `fx_daily`. USD/CLP, UF/CLP and EUR/CLP keep their own tables.
CREATE TABLE fx_rates (
  base TEXT NOT NULL,
  quote TEXT NOT NULL,
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  mid REAL NOT NULL CHECK (mid > 0),
  source TEXT NOT NULL,
  PRIMARY KEY (base, quote, date)
);
