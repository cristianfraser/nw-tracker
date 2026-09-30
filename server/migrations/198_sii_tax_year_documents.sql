-- What the SII has for a tax year (año tributario), read from its own documents:
--   sii_f22_filed      — every amount code of the Formulario 22 as filed («F22 Compacto» PDF);
--   sii_informed_dj    — the summary of each declaración jurada third parties filed about the
--                        taxpayer (the «Información de sus ingresos» xlsx), one row per column,
--                        the value as printed (Chilean format).
-- Filled by server/scripts/import-sii-tax-year.ts; the local F22 draft (f22Draft.ts) compares the
-- app's own figures with both.
CREATE TABLE IF NOT EXISTS sii_f22_filed (
  tax_year INTEGER NOT NULL,
  code INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  source_file TEXT NOT NULL,
  PRIMARY KEY (tax_year, code)
);

CREATE TABLE IF NOT EXISTS sii_informed_dj (
  tax_year INTEGER NOT NULL,
  dj_code INTEGER NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  source_file TEXT NOT NULL,
  PRIMARY KEY (tax_year, dj_code, field)
);
