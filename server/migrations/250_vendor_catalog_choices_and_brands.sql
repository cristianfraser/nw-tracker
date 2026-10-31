-- Vendor catalog: a third source, `choice` — the branch the user picked on an expense row among the
-- places a cut name could be (vendorCatalog.ts). SQLite cannot alter a CHECK, so the table is
-- rebuilt with its rows (no other table references it). Plus more generic brands.
CREATE TABLE vendor_catalog_next (
  id INTEGER PRIMARY KEY,
  match_kind TEXT NOT NULL CHECK (match_kind IN ('exact', 'prefix', 'branch', 'rut')),
  pattern TEXT NOT NULL CHECK (pattern <> ''),
  display TEXT NOT NULL CHECK (display <> ''),
  source TEXT NOT NULL CHECK (source IN ('seed', 'user', 'choice')),
  UNIQUE (match_kind, pattern, source)
);

INSERT INTO vendor_catalog_next (id, match_kind, pattern, display, source)
SELECT id, match_kind, pattern, display, source FROM vendor_catalog;

DROP TABLE vendor_catalog;

ALTER TABLE vendor_catalog_next RENAME TO vendor_catalog;

INSERT OR IGNORE INTO vendor_catalog (match_kind, pattern, display, source) VALUES
  ('prefix', 'AMAZON', 'Amazon.com', 'seed'),
  ('prefix', 'UBER* TRIP', 'Uber', 'seed'),
  ('prefix', 'UBER *CORNERSHOP', 'Cornershop', 'seed'),
  ('prefix', 'UBER *PASS', 'Uber One', 'seed'),
  ('prefix', 'UBER EATS', 'Uber Eats', 'seed'),
  ('prefix', 'MERCADO PAGO', 'Mercado Pago', 'seed'),
  ('prefix', 'WWW MERCADOPAGO CL', 'Mercado Pago', 'seed'),
  ('exact', 'MCDONALD', 'McDonald''s', 'seed'),
  ('exact', 'STREATBURGER', 'Streat Burger', 'seed'),
  ('branch', 'STREAT BURGUER', 'Streat Burger', 'seed'),
  ('prefix', '2PRODUCT', 'Mercadolibre (Chile)', 'seed'),
  ('prefix', '3PRODUCT', 'Mercadolibre (Chile)', 'seed'),
  ('prefix', '4PRODUCT', 'Mercadolibre (Chile)', 'seed'),
  ('prefix', '5PRODUCT', 'Mercadolibre (Chile)', 'seed'),
  ('prefix', '6PRODUCT', 'Mercadolibre (Chile)', 'seed'),
  ('prefix', 'MACH ONE CLICK', 'MACH (carga)', 'seed'),
  ('prefix', 'MACH WEBPAY ONECLICK', 'MACH (carga)', 'seed'),
  ('prefix', 'ALMACENES BIL', 'Almacenes Bilbao', 'seed'),
  ('prefix', 'SMILEGREEN', 'Smilegreen', 'seed'),
  ('exact', 'YIN JO', 'Yin Jo', 'seed'),
  ('exact', 'YIN', 'Yin Jo', 'seed'),
  ('prefix', 'CENCOPAY', 'Cencopay', 'seed'),
  ('prefix', 'PARKING ALTO LAS CONDE', 'Parking Alto Las Condes', 'seed'),
  ('prefix', 'MUEVO COPEC', 'Copec (App)', 'seed'),
  ('prefix', 'LIDER DOMICILIO', 'Lider (domicilio)', 'seed'),
  ('prefix', 'PINARES.CL', 'Pinares', 'seed'),
  ('exact', 'PAPAS RICAS Y', 'Papas Ricas', 'seed'),
  ('branch', 'FARMACIAS', 'Farmacias', 'seed'),
  ('exact', 'ADIDAS', 'adidas', 'seed'),
  ('prefix', 'CHILEFARMA', 'Chilefarma', 'seed'),
  ('branch', 'HIPER', 'Hiper Lider', 'seed'),
  ('branch', 'UNIMARC', 'Unimarc', 'seed'),
  ('prefix', 'RAPPI', 'Rappi', 'seed'),
  ('prefix', 'PLAYSTATION NETWORK', 'PlayStation Network', 'seed'),
  ('prefix', '1PASSWORD', '1Password', 'seed'),
  ('exact', 'CRUZ BLANCA', 'Isapre Cruz Blanca', 'seed'),
  ('prefix', 'MUTUARIA', 'Mutuaria', 'seed'),
  ('prefix', 'OKM SUECIA', 'OK Market', 'seed'),
  ('prefix', 'LONDON COFFEE ALCANT', 'Santander Work/Café (Alcántara)', 'seed'),
  ('prefix', 'GOOGLE PLAY-YO', 'YouTube Premium', 'seed'),
  ('prefix', 'IKEA COM', 'Ikea', 'seed');
