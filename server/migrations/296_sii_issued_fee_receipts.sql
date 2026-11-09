-- The boletas de honorarios the taxpayer issued (art. 42 N°2 income), as the SII records them:
-- the gross fee, the 13,75 %-style retention and who paid it to the SII (the payer, who withholds,
-- or the issuer, through his own F29). The local F22 draft (f22Draft.ts) builds the fees box from
-- them for a year with no filed form: gross (547), presumed expenses (494), net (110) and the
-- retention credit (198). Personal data: empty unless a document fills it (the demo generator
-- writes its person's).
CREATE TABLE IF NOT EXISTS sii_issued_fee_receipts (
  id INTEGER PRIMARY KEY,
  number INTEGER NOT NULL,
  issued_on TEXT NOT NULL CHECK (issued_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  payer_name TEXT NOT NULL,
  gross_clp INTEGER NOT NULL CHECK (gross_clp > 0),
  retention_clp INTEGER NOT NULL CHECK (retention_clp >= 0 AND retention_clp < gross_clp),
  retained_by TEXT NOT NULL CHECK (retained_by IN ('payer', 'issuer')),
  source_file TEXT NOT NULL,
  UNIQUE (number)
);

CREATE INDEX IF NOT EXISTS sii_issued_fee_receipts_issued_on ON sii_issued_fee_receipts (issued_on);
