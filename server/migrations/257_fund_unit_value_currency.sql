-- A fund's unit price is a quantity of its quote currency (docs/holdings-currency-plan.md): the
-- column names no currency, and `currency` says which. Every series stored today is quoted in
-- pesos. RENAME COLUMN rewrites the mark-input triggers that watch the column.
ALTER TABLE fund_unit_daily RENAME COLUMN unit_value_clp TO unit_value;

ALTER TABLE fund_unit_daily ADD COLUMN currency TEXT NOT NULL DEFAULT 'clp' CHECK (currency IN ('clp', 'usd', 'uf', 'eur'))
;

-- The Superintendencia's official valor cuota, same rule.
ALTER TABLE pension_fund_unit_official RENAME COLUMN unit_value_clp TO unit_value;

ALTER TABLE pension_fund_unit_official ADD COLUMN currency TEXT NOT NULL DEFAULT 'clp' CHECK (currency IN ('clp', 'usd', 'uf', 'eur'))
