-- Where a category rule came from (`expense_category_rules.origin`): NULL, the user's pick or a
-- catalog change (`vendorCatalogChange.ts`), as before; `cartola_spelling`, a rule passed over to the
-- new spelling of a cartola description imported again in place (`checkingRestatementCarry.ts`), so
-- the row keeps the category its old spelling's rule gave it. A user's change of the rule writes
-- NULL (`setExpenseCategoryRule`). The paired hook reinstalls the table's write-log update trigger
-- over the new column.
ALTER TABLE expense_category_rules ADD COLUMN origin TEXT CHECK (origin IS NULL OR origin = 'cartola_spelling')
