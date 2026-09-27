-- Gross amount and withholding tax behind a dividend, for tax planning (2026-09-23).
--
-- The `dividend_payout` movement keeps the NET amount the broker credited (the only figure the
-- balance walk and every P/L reader need). What the tax year needs on top — the gross dividend
-- and the tax withheld abroad, which Chile credits against the local tax on the gross — lives
-- here, one row per dividend movement, in the depto_payments satellite pattern. Every nullable
-- column is filled only when the source document prints it, never derived: a rate is stored
-- when the statement says «at 15%», never computed from gross and tax.
--
-- Broker-agnostic by construction. Racional's dividends API (DIV / DIVTAX / amount), Fintual's
-- Alpaca monthly statement («Cash DIV @ 1.903516, Pos QTY …» + «Div. Adj(NRA Withheld) … at
-- 15% for tax country CHL») and Fintual's certificado de eventos de capital (bruto / impuestos /
-- neto) all write the same shape, and a future IBKR activity statement (Dividends + Withholding
-- Tax sections) needs nothing new. `source` names the document class, `source_ref` the file or
-- ledger key it came from, `broker_event_id` the broker's own id when it has one (Racional's
-- `div_…` route id) — unique per source, so two ledger rows can never claim one broker event.
CREATE TABLE movement_dividend_details (
  movement_id INTEGER PRIMARY KEY REFERENCES movements(id) ON DELETE CASCADE,
  gross_amount REAL NOT NULL CHECK (gross_amount >= 0),
  withholding_amount REAL NOT NULL CHECK (withholding_amount >= 0),
  currency TEXT NOT NULL CHECK (currency IN ('clp', 'usd', 'eur')),
  withholding_rate_pct REAL CHECK (withholding_rate_pct IS NULL OR (withholding_rate_pct >= 0 AND withholding_rate_pct <= 100)),
  withholding_jurisdiction TEXT,
  tax_residency_country TEXT,
  per_share_amount REAL CHECK (per_share_amount IS NULL OR per_share_amount >= 0),
  position_qty REAL CHECK (position_qty IS NULL OR position_qty >= 0),
  record_date TEXT,
  pay_date TEXT,
  broker_event_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('racional_api', 'fintual_cartola', 'fintual_certificado', 'ibkr_statement', 'manual')),
  source_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX movement_dividend_details_source_event
  ON movement_dividend_details (source, broker_event_id)
  WHERE broker_event_id IS NOT NULL;
