-- Traspaso de deuda: the bank moves USD debt onto the CLP side of the same card — the USD
-- statement's abono leg and the CLP statement's cargo leg of one facturación are a single
-- reclassification (no cash moves, total debt unchanged). The link stores the bank's hard
-- conversion (amount_clp <-> amount_usd, both positive; implied rate = amount_clp / amount_usd)
-- so consumers value the pair as exactly net-zero instead of converting the USD leg at a
-- looked-up fx rate. Rows are derived state: rebuilt per account by
-- relinkCcTraspasoDeudaLinksForAccount on every PDF statement import (statement line
-- replacement cascades old rows away). Web-paste bucket lines never participate.
CREATE TABLE IF NOT EXISTS cc_traspaso_deuda_links (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  clp_line_id INTEGER NOT NULL UNIQUE REFERENCES cc_statement_lines(id) ON DELETE CASCADE,
  usd_line_id INTEGER NOT NULL UNIQUE REFERENCES cc_statement_lines(id) ON DELETE CASCADE,
  amount_clp INTEGER NOT NULL CHECK (amount_clp > 0),
  amount_usd REAL NOT NULL CHECK (amount_usd > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (clp_line_id <> usd_line_id)
);

CREATE INDEX IF NOT EXISTS idx_cc_traspaso_deuda_links_account
  ON cc_traspaso_deuda_links(account_id);
