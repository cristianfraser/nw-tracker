-- A municipality's card charges are its permiso de circulación (the comuna as the branch): the seed
-- entries read «Permiso de circulación (Maipú)», and the category rule moves to the new vendor key.
-- A municipal charge that is something else (a fine) takes its category on the line itself.
UPDATE vendor_catalog SET display = 'Permiso de circulación'
WHERE source = 'seed' AND match_kind = 'branch' AND pattern IN ('MUNICIPALIDAD DE', 'MUNICIPALIDAD');

INSERT OR IGNORE INTO expense_category_rules (vendor, link_kind, link_key, category_id)
SELECT 'PERMISO DE CIRCULACION', link_kind, link_key, category_id FROM expense_category_rules WHERE vendor = 'MUNICIPALIDAD';

DELETE FROM expense_category_rules WHERE vendor = 'MUNICIPALIDAD';
