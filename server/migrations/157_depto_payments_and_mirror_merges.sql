-- Promote note-embedded machine payloads into real tables (notes are provenance for humans):
-- depto payment rows (legacy import:excel|depto-* / manual|depto-* notes) -> depto_payments;
-- mirror-merge undo payloads -> movement_mirror_merges. A post-migration hook in db.ts
-- (runLegacyNoteBackfill157) parses existing notes into these tables and rewrites the notes
-- to human summaries; fresh DBs have no such notes and the hook is a no-op.

CREATE TABLE IF NOT EXISTS depto_payments (
  movement_id INTEGER PRIMARY KEY REFERENCES movements(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('dividendos','mortgage')),
  origin TEXT NOT NULL CHECK (origin IN ('import','manual')),
  cuota TEXT NOT NULL,
  amount_uf REAL,
  credito_restante_uf REAL,
  valor_vivienda_uf REAL,
  valor_neto_uf REAL,
  valor_neto_clp REAL,
  pagado_neto_uf REAL,
  pago_acumulado_clp REAL,
  min_uf REAL,
  amortizacion_clp REAL,
  amortizacion_uf REAL,
  amortizacion_ext_clp REAL,
  amortizacion_ext_uf REAL,
  interes_clp REAL,
  interes_uf REAL,
  incendio_clp REAL,
  desgravamen_clp REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS movement_mirror_merges (
  transfer_movement_id INTEGER PRIMARY KEY REFERENCES movements(id) ON DELETE CASCADE,
  out_movement_id INTEGER NOT NULL,
  out_occurred_on TEXT NOT NULL,
  out_amount_clp REAL NOT NULL,
  out_units_delta REAL,
  out_note TEXT,
  in_movement_id INTEGER NOT NULL,
  in_occurred_on TEXT NOT NULL,
  in_amount_clp REAL NOT NULL,
  in_units_delta REAL,
  in_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
