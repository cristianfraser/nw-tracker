-- Manual expenses name what they were in a column (docs/untangle-plan.md F9 step 2): the Expenses
-- page showed the note with its `manual:` provenance prefix cut off. `merchant` is what the user
-- wrote; the note keeps the human text. The hook (`manualExpenseMerchant275.ts`) fills the rows on
-- file from their notes once and reports how many it filled.
ALTER TABLE expense_entries ADD COLUMN merchant TEXT;
