-- The rentals (docs/demo-us-chapter-plan.md phase 4b).
--
-- A place may be a DFL-2 «vivienda económica» (DFL N° 2 de 1959: ≤ 140 m² built, certified at the
-- building's reception). The flag drives both benefits: its rent is not income for a natural person
-- with up to two such properties (art. 15; the F22 does not declare it, Suplemento line 9, 9.3 g),
-- and its contribuciones are halved for 20 / 15 / 10 years from the reception by built area (art.
-- 14; `dfl2ContribucionesHalvedThroughYear` in legalParameters.ts). The area and the reception year
-- are set with the flag and only with it (the writer checks it, `setRealEstatePlaceDfl2`).
ALTER TABLE expense_accounts ADD COLUMN dfl2 INTEGER NOT NULL DEFAULT 0 CHECK (dfl2 IN (0, 1));
ALTER TABLE expense_accounts ADD COLUMN dfl2_built_m2 REAL;
ALTER TABLE expense_accounts ADD COLUMN dfl2_reception_year INTEGER;

-- A checking credit the user marks as rent names the place it is the rent of, so the F22 can tell
-- exempt DFL-2 rent from taxable rent (art. 20 N°1 b), code 1849). The income_kind CHECK is a table
-- constraint, so the table is rebuilt (nothing references it; the hook re-creates its write
-- triggers, which went with the old table). Other tables' triggers name it (the flow retirement
-- checks, migration 290), so the rename runs with legacy_alter_table: the modern rename re-parses
-- every trigger and fails on those names while the table is briefly missing.
CREATE TABLE flow_income_overrides_299 (
  flow_id INTEGER PRIMARY KEY REFERENCES flows(id),
  is_excluded INTEGER NOT NULL DEFAULT 0 CHECK (is_excluded IN (0, 1)),
  income_kind TEXT CHECK (income_kind IN ('salary', 'severance', 'other', 'parent_gift', 'card_reimbursement', 'rent')),
  note TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  force_include INTEGER NOT NULL DEFAULT 0,
  rent_place_id INTEGER REFERENCES expense_accounts(id),
  CHECK ((income_kind IS 'rent') = (rent_place_id IS NOT NULL))
);
INSERT INTO flow_income_overrides_299 (flow_id, is_excluded, income_kind, note, updated_at, force_include)
  SELECT flow_id, is_excluded, income_kind, note, updated_at, force_include FROM flow_income_overrides;
DROP TABLE flow_income_overrides;
PRAGMA legacy_alter_table = ON;
ALTER TABLE flow_income_overrides_299 RENAME TO flow_income_overrides;
PRAGMA legacy_alter_table = OFF;
CREATE INDEX idx_flow_income_overrides_is_excluded ON flow_income_overrides(is_excluded);
