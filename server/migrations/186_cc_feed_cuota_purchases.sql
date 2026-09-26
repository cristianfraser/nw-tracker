-- Cuota purchases from the Santander card feed (2026-09-26).
--
-- The unbilled-movements feed types every row. Two types are cuota purchases, listed at their
-- full principal: «CUOTA COMERCIO» (merchant-financed, Santander bills cuota 1 at the NEXT close
-- and prints 00/N on the purchase cycle's statement) and «N/CUOTAS PRECIO CONTADO» (cuota 1 bills
-- at the purchase cycle's own close). The feed carries no cuota count, but a «cuota comercio»
-- purchase comes with a same-day stamp-tax row (IMPTO. DECRETO LEY 3475, same merchant) worth
-- principal x 0,066% x (cuotas + 1) months, capped at 0,8% — exact for up to 11 cuotas.
--
-- Until now both were imported as one-shot purchases at full price, so the open facturación
-- counted the whole principal as billed that cycle (2026-09 ·0901: 2xx.xxx of the 206k gap).
--
--   cc_feed_installment_plans: a plan the feed importer created because the count is known
--   (stamp tax, or a type that names it). The plan itself is an ordinary `source = 'manual'` row
--   (so the statement's twin reconcile replaces it exactly as it replaces a hand-entered one); this
--   table is its provenance.
--
--   cc_statement_lines.cuota_purchase_kind: a feed row that IS a cuota purchase but whose count is
--   unknown (every «precio contado», a «cuota comercio» past the tax cap). It stays a line — what
--   is owed is the full principal from the purchase date either way — but the billing views stop
--   counting it as billed in its cycle. The statement's plan supersedes it.
ALTER TABLE cc_statement_lines ADD COLUMN cuota_purchase_kind TEXT
  CHECK (cuota_purchase_kind IS NULL OR cuota_purchase_kind IN ('cuota_comercio', 'precio_contado'));

CREATE TABLE cc_feed_installment_plans (
  purchase_id INTEGER PRIMARY KEY REFERENCES cc_installment_purchases(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('cuota_comercio', 'precio_contado')),
  cuotas_source TEXT NOT NULL CHECK (cuotas_source IN ('stamp_tax', 'feed_type')),
  stamp_tax_clp INTEGER,
  feed_file TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
