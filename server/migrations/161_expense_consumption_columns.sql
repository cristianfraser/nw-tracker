-- Real-estate bill consumption (kWh / m³) lived as `kwh=` / `m3=` tags packed in
-- expense_entries.note — machine data in a note (client parsed it at render time).
-- Promote to honest columns; the paired post-migration hook (legacyNoteBackfills.ts)
-- moves the values over and strips the tags, keeping the rest of the note as provenance.
ALTER TABLE expense_entries ADD COLUMN kwh REAL;
ALTER TABLE expense_entries ADD COLUMN m3 REAL;

-- Occupancy period per tracked place (YYYY-MM, inclusive; active_to NULL = current).
-- Values are personal data — set directly in the live DB, not seeded here.
ALTER TABLE expense_accounts ADD COLUMN active_from TEXT;
ALTER TABLE expense_accounts ADD COLUMN active_to TEXT;
