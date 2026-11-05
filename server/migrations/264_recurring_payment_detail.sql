-- A declared payment's detail («1ª cuota») in its own column, apart from its name («Permiso de
-- circulación»): the «Próximos pagos» row shows the name, the detail is on hover. Rows declared
-- before this carried the detail after « · » in the name; they are split once here.
ALTER TABLE recurring_payments ADD COLUMN detail TEXT CHECK (detail IS NULL OR length(trim(detail)) > 0);
UPDATE recurring_payments
SET detail = trim(substr(name, instr(name, ' · ') + length(' · '))),
    name = trim(substr(name, 1, instr(name, ' · ') - 1))
WHERE instr(name, ' · ') > 1
