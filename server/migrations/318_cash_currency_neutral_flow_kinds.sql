-- Phase C1 of docs/any-currency-plan.md: cash held in any currency.
--
-- An account declares the currency its cash ledger holds (a dollar or a euro account), instead of the
-- leaf slug naming it. The paired POST_MIGRATION_HOOKS entry (server/src/cashCurrency318.ts) fills it
-- for the existing cash leaves and re-creates the triggers that read the new column and kind names.
ALTER TABLE accounts ADD COLUMN cash_currency TEXT REFERENCES currencies(code);

-- Flow kinds named after a currency pair become currency-neutral: the legs carry their currencies.
UPDATE movements SET flow_kind = 'fx_exchange' WHERE flow_kind = 'compra_usd_venta_clp';
UPDATE movements SET flow_kind = 'fx_purchase' WHERE flow_kind = 'compra_usd';
UPDATE movements SET flow_kind = 'deposit' WHERE flow_kind IN ('deposit_clp', 'deposit_usd');
UPDATE movements SET flow_kind = 'withdrawal' WHERE flow_kind IN ('withdrawal_clp', 'withdrawal_usd');
UPDATE movements SET flow_kind = 'state_bonus' WHERE flow_kind = 'aporte_estatal_clp';
UPDATE movements SET flow_kind = 'state_bonus_transfer_in' WHERE flow_kind = 'traspaso_bonificacion_clp';
