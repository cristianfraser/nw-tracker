-- When a flow's money moved, as its own source document states it (not a pairing: those are read
-- when the rows are listed, `latestMovementOrder.ts`). One row per flow, written at insert by the
-- source that knows the moment (Racional's movement list: each row's creation instant; Santander's
-- dollar account feed: each row's operation time, recorded on the ledger row it confirms), carried
-- through flow merges (`flows/flowEventTimes.ts`). Read only to order a day's «Últimos
-- movimientos»; the dollar lot walk keeps reading `movement_event_times`. UTC ISO instant.
CREATE TABLE IF NOT EXISTS flow_event_times (
  flow_id INTEGER PRIMARY KEY REFERENCES flows(id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL CHECK (occurred_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T*Z'),
  source TEXT NOT NULL CHECK (source IN ('racional_movements', 'santander_account_feed')),
  source_ref TEXT NOT NULL
);
