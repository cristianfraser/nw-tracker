-- TRASPASO A/DE DEUDA statement lines resolve to no_cuenta via the derived branch in
-- resolveCcExpenseCategorySlug, but the generic-transfer Único auto-registration was
-- creating NULL-category cc_expense_unique_purchases rows for them on every gastos load.
-- A NULL row means Único-sin-categoría mode, which short-circuits resolution to
-- «Sin clasificar» before the traspaso branch — so new traspaso lines showed unclassified
-- until manually fixed. The registration now skips traspaso merchants; this deletes the
-- auto-created shadow rows. Rows with a category set (user-assigned no_cuenta) are kept,
-- and any future NULL row can only come from an explicit user clear.
DELETE FROM cc_expense_unique_purchases
WHERE category_id IS NULL
  AND purchase_key IN (
    SELECT 'line-pr:' || l.parser_row_id
    FROM cc_statement_lines l
    WHERE l.parser_row_id IS NOT NULL
      AND UPPER(l.merchant) LIKE '%TRASPASO%'
      AND UPPER(l.merchant) LIKE '%DEUDA%'
  );
