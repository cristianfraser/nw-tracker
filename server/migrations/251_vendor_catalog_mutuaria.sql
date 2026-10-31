-- Mutuaria administered the mortgage before MetLife: its card charges are the same mortgage.
UPDATE vendor_catalog SET display = 'MetLife Hipotecario' WHERE source = 'seed' AND match_kind = 'prefix' AND pattern = 'MUTUARIA';
