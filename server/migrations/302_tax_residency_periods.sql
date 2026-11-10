-- A declared tax residency (docs/demo-app-features-plan.md §1, wave R1). The user (or the demo
-- generator) states where he is a tax resident from a given day; the app never infers it from
-- pay stubs, days abroad or accounts. One open period at a time: declaring a new one closes the
-- previous the day before (done by the writer, `taxResidency.ts`, not here). The F22 draft reads it
-- to decide the regime of an income year (resident, non-resident, or the departure year split), so a
-- change here reaches the caches through the write log (the triggers are added by the migration's
-- hook, `taxResidency302.ts`).
CREATE TABLE IF NOT EXISTS tax_residency_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jurisdiction TEXT NOT NULL CHECK (jurisdiction IN ('cl', 'us')),
  from_date TEXT NOT NULL CHECK (from_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  to_date TEXT CHECK (to_date IS NULL OR to_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (to_date IS NULL OR to_date >= from_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS tax_residency_periods_from ON tax_residency_periods (from_date);
