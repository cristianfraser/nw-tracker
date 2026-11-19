-- What each broker calls the lines it holds: the broker's own symbol and name, from its positions
-- read (`broker.positions`). A buy notification that names only the company («… acciones de
-- Anthropic PBC») resolves to the symbol the broker itself prints. One row per broker and symbol;
-- `name` follows the broker's latest statement.
CREATE TABLE broker_instruments (
  broker TEXT NOT NULL CHECK (broker IN ('fintual', 'racional')),
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (broker, symbol)
)
