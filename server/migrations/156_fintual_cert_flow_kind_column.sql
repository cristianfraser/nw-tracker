-- Promote the Fintual certificado deposit classification from the movement note tag
-- (`|flow_kind=…`) to the movements.flow_kind column. Runtime no longer parses the note.
--
-- Only the non-default deposit kinds (state bonus / traspaso) are stored in the column;
-- a plain personal deposit stays NULL (the sign of amount_clp distinguishes deposit vs
-- withdrawal, matching every other cash movement). The deposit flow_kind note tags are then
-- stripped — goal/day/medio remain as human provenance. Mortgage flow_kind tags are left
-- for the depto ledger migration.

UPDATE movements
SET flow_kind = 'aporte_estatal_clp'
WHERE flow_kind IS NULL AND note LIKE '%|flow_kind=aporte_estatal_clp%';

UPDATE movements
SET flow_kind = 'traspaso_bonificacion_clp'
WHERE flow_kind IS NULL AND note LIKE '%|flow_kind=traspaso_bonificacion_clp%';

UPDATE movements
SET note = REPLACE(note, '|flow_kind=aporte_estatal_clp', '')
WHERE note LIKE '%|flow_kind=aporte_estatal_clp%';

UPDATE movements
SET note = REPLACE(note, '|flow_kind=traspaso_bonificacion_clp', '')
WHERE note LIKE '%|flow_kind=traspaso_bonificacion_clp%';

UPDATE movements
SET note = REPLACE(note, '|flow_kind=deposit_clp', '')
WHERE note LIKE '%|flow_kind=deposit_clp%';
