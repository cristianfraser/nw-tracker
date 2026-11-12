-- A card statement line is `amount` + `currency` and `cuota_amount` (migration 319), and nothing
-- reads the peso / dollar columns generated from them any more (docs/any-currency-plan.md, Phase
-- C3): the readers that still want that view compute it (server/src/cards/lineAmountSql.ts).
-- Dropping a generated column touches no stored row and keeps every index and trigger of the table
-- as it is, in its order (no trigger names these columns since migration 319).
ALTER TABLE cc_statement_lines DROP COLUMN amount_clp;
ALTER TABLE cc_statement_lines DROP COLUMN amount_usd;
ALTER TABLE cc_statement_lines DROP COLUMN valor_cuota_mensual_clp;
ALTER TABLE cc_statement_lines DROP COLUMN valor_cuota_mensual_usd;
