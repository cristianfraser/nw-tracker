-- More generic brands for the vendor catalog (see 248). Exact rows name one store whose printed
-- branch reads badly through its brand's branch row («SABA ARAUCO PAO»); exact is matched first.
INSERT OR IGNORE INTO vendor_catalog (match_kind, pattern, display, source) VALUES
  ('exact', 'ARCOSDEVALPARAISO', 'McDonald''s (San Martín)', 'seed'),
  ('exact', 'UNIMARC SANTA MARIA', 'Unimarc (Santa María)', 'seed'),
  ('exact', 'CONAGALLAS', 'Pescadería Con Agallas', 'seed'),
  ('prefix', 'DL*GOOGLE YOUTUBE', 'YouTube Premium', 'seed'),
  ('exact', 'LOS MISIONEROS', 'Los Misioneros', 'seed'),
  ('branch', 'IKEA', 'Ikea', 'seed'),
  ('exact', 'SABA ARAUCO PAO', 'Saba (Parque Arauco)', 'seed'),
  ('exact', 'CLINICA ALEMANA PZA EGANA', 'Clínica Alemana (Plaza Egaña)', 'seed'),
  ('exact', 'SEG AUTO SANTANDER', 'Seguro Auto Santander', 'seed'),
  ('prefix', 'ANTHROPIC', 'Claude', 'seed'),
  ('branch', 'ARAMCO', 'Aramco', 'seed'),
  ('prefix', 'RENDER.COM', 'render.com', 'seed');
