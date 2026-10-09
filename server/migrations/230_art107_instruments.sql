-- Which equity instruments are taxed under art. 107 LIR: the mayor valor of a sale in bolsa pays
-- a 10% impuesto único from 2022-09-02 (Ley 21.420) and is ingreso no renta again from
-- 2027-01-01. `fund` = cuotas of a fondo de inversión or fondo mutuo (art. 107 N°2, F22 code
-- 1813), `share` = a Chilean S.A. share with presencia bursátil (N°1, code 1809). Structured
-- state: a `.SN` suffix alone never decides it (a Chilean share and a fund trade on the same
-- bolsa under different numbers of the article). Read by art107Instruments.ts.
--
-- Seeded with the Singular IPSA ETF fund, whose reglamento interno is built for art. 107 N°2.
-- A public ticker, not personal data: a DB with no account on it (demo, CI) gets the row and
-- nothing reads it.
CREATE TABLE art107_instruments (
  ticker TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('fund', 'share')),
  note TEXT
);

INSERT INTO art107_instruments (ticker, kind, note)
VALUES ('CFIETFIPSA.SN', 'fund', 'Fondo de Inversión ETF Singular IPSA');
