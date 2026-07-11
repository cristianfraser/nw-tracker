-- Evidence-backed first-cuota billing month for an installment plan (YYYY-MM).
-- Manual plans otherwise guess first-due = open facturación + 1 (the Santander
-- "cuota 00 informativa" convention). BCI bills cuota 01 in the purchase's own
-- facturación, so a web-paste of "movimientos no facturados" that re-lists a plan's
-- upcoming cuota is the evidence that pins its real first month. NULL = no evidence
-- yet (fall back to the derivation in purchaseFirstDueYm). Write-once, set by the
-- web-paste importer; a later PDF cuota-01 line still outranks it at read time.
ALTER TABLE cc_installment_purchases ADD COLUMN first_due_month TEXT;
