-- How a currency prints (2026-11-23): one formatter (`formatMoney`) prints every currency from its
-- row. `symbol_after` puts the symbol after the figure («1.234,00 UF»); `display_digits` is how many
-- decimals a figure shows when that differs from the digits it is counted in (`minor_digits`): the
-- UF is counted to 4 decimals and shown with 2. Null = `minor_digits`.
ALTER TABLE currencies ADD COLUMN symbol_after INTEGER NOT NULL DEFAULT 0 CHECK (symbol_after IN (0, 1));
ALTER TABLE currencies ADD COLUMN display_digits INTEGER CHECK (display_digits BETWEEN 0 AND 4);
UPDATE currencies SET symbol = 'UF', symbol_after = 1, display_digits = 2 WHERE code = 'uf';
