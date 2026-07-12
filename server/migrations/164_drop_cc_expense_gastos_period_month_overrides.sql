-- Gastos-month smoothing overrides removed: the general gastos view shows real
-- expense dates; billed-period framing lives in the real-estate expenses view
-- (mortgage cuota months derive from depto_payments cuota numbers there).
-- The only rows ever written were the two mortgage skip/double-payment smoothings.
DROP TABLE IF EXISTS cc_expense_gastos_period_month_overrides;
