-- A US federal Form 1040 as filed, and how it was settled (docs/demo-us-chapter-plan.md, phase 5).
-- The US twin of `sii_f22_filed` + `f22_settlements`, in tables of its own: a 1040 is keyed by
-- calendar tax year (the F22 by año tributario), its lines are the form's labels («1a», «25d»,
-- «35a») where the F22's codes are integers, its amounts are whole dollars, and it carries a filing
-- status — a jurisdiction column on the F22 tables would have changed every F22 reader.
--   us_f1040_returns        one row per filed return: filing status, the day it was filed, the document;
--   us_f1040_filed_lines    every line the return printed (whole dollars), checked against the form's
--                           arithmetic by the writer (`recordFiledF1040`, f1040Filed.ts);
--   us_f1040_settlements    the IRS refund or the payment, by the movement on the account that
--                           received or paid it (`linkF1040Settlement`).
CREATE TABLE IF NOT EXISTS us_f1040_returns (
  tax_year INTEGER PRIMARY KEY,
  filing_status TEXT NOT NULL CHECK (filing_status IN ('single', 'married_jointly')),
  filed_on TEXT NOT NULL CHECK (filed_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  source_file TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS us_f1040_filed_lines (
  tax_year INTEGER NOT NULL REFERENCES us_f1040_returns(tax_year) ON DELETE CASCADE,
  line TEXT NOT NULL,
  amount INTEGER NOT NULL,
  PRIMARY KEY (tax_year, line)
);

CREATE TABLE IF NOT EXISTS us_f1040_settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tax_year INTEGER NOT NULL REFERENCES us_f1040_returns(tax_year) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('refund', 'payment')),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  movement_id INTEGER NOT NULL UNIQUE REFERENCES movements(id) ON DELETE RESTRICT,
  occurred_on TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount > 0),
  description TEXT NOT NULL
);
