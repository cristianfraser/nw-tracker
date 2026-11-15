-- Stored cupo-check verdicts (`cc_bank_cupo_checks.detail`, JSON) written before the owed figures
-- were kept per currency carry the dollar side under `owed.usd`. The current shape keeps every
-- foreign currency under `owed.foreign.<code>` (`ccOwedByCurrency.ts`). Rewrite the old rows once,
-- so the report reads one shape (docs/untangle-plan.md, wave 8b guards audit).
UPDATE cc_bank_cupo_checks
SET detail = json_remove(
  json_set(detail, '$.owed.foreign', json_object('usd', json(json_extract(detail, '$.owed.usd')))),
  '$.owed.usd'
)
WHERE json_type(detail, '$.owed.usd') = 'object'
  AND json_type(detail, '$.owed.foreign') IS NULL;
