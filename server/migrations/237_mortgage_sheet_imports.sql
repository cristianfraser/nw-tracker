-- The mortgage sheet (the user's Numbers table) as an ingest source (`mortgage.sheet_payments`):
-- the bank's posted cuota máxima joins the stored cuota figures, and each applied document is
-- recorded so re-sending the same file answers `duplicate`.
ALTER TABLE depto_payments ADD COLUMN max_uf REAL;

CREATE TABLE IF NOT EXISTS mortgage_sheet_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  document_size INTEGER NOT NULL,
  document_modified_at TEXT NOT NULL,
  rows_written INTEGER NOT NULL,
  rows_checked INTEGER NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mortgage_sheet_imports_sha ON mortgage_sheet_imports(sha256);
