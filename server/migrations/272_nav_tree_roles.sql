-- Nav tree roles as data (docs/untangle-plan.md F4): what a portfolio group IS to the code that
-- values and draws it, instead of slug literals scattered over the payload builders.
-- - nw_bucket: one of the net-worth buckets the home cards, totals and charts sum (net worth = Σ).
-- - investment_root: a root of the «Inversiones» total and the Rentabilidad pages.
-- - nets_linked_group_id: the group whose owed total this group's value nets (the cash bucket and
--   its savings card net the linked credit cards).
-- - property_overlay: the group's chart carries the property's «hipoteca»/«valor» overlay lines.
-- The hook (`navTreeRoles272.ts`) seeds the existing nodes from today's slugs and re-creates the
-- table's write-log update trigger with the new columns.
ALTER TABLE portfolio_groups ADD COLUMN nw_bucket INTEGER NOT NULL DEFAULT 0 CHECK (nw_bucket IN (0, 1));
ALTER TABLE portfolio_groups ADD COLUMN investment_root INTEGER NOT NULL DEFAULT 0 CHECK (investment_root IN (0, 1));
ALTER TABLE portfolio_groups ADD COLUMN nets_linked_group_id INTEGER REFERENCES portfolio_groups(id) ON DELETE SET NULL;
ALTER TABLE portfolio_groups ADD COLUMN property_overlay INTEGER NOT NULL DEFAULT 0 CHECK (property_overlay IN (0, 1));
