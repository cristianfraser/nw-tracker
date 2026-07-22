-- Checking↔credit-card payment mirrors: the "in" side of a CC-payment mirror is statement
-- evidence, not a movement — a PAGO/MONTO CANCELADO statement line (legacy formats) or the
-- statement's monto_pagado_anterior header (current format). Relax in_movement_id to
-- nullable and add the two evidence refs; exactly one in-ref must be set.
CREATE TABLE movement_mirror_merges_new (
  transfer_movement_id INTEGER PRIMARY KEY REFERENCES movements(id) ON DELETE CASCADE,
  out_movement_id INTEGER NOT NULL,
  out_occurred_on TEXT NOT NULL,
  out_amount_clp REAL NOT NULL,
  out_units_delta REAL,
  out_note TEXT,
  in_movement_id INTEGER,
  in_statement_line_id INTEGER,
  in_statement_id INTEGER,
  in_occurred_on TEXT NOT NULL,
  in_amount_clp REAL NOT NULL,
  in_units_delta REAL,
  in_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (in_movement_id IS NOT NULL) + (in_statement_line_id IS NOT NULL) + (in_statement_id IS NOT NULL) = 1
  )
);
INSERT INTO movement_mirror_merges_new (
  transfer_movement_id, out_movement_id, out_occurred_on, out_amount_clp, out_units_delta, out_note,
  in_movement_id, in_occurred_on, in_amount_clp, in_units_delta, in_note, created_at
)
SELECT transfer_movement_id, out_movement_id, out_occurred_on, out_amount_clp, out_units_delta, out_note,
       in_movement_id, in_occurred_on, in_amount_clp, in_units_delta, in_note, created_at
FROM movement_mirror_merges;
DROP TABLE movement_mirror_merges;
ALTER TABLE movement_mirror_merges_new RENAME TO movement_mirror_merges
