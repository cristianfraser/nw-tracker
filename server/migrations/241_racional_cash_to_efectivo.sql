-- The broker's cash balances are cash, not investments: Racional CLP (import key
-- `import:panel|kind=clp|key=clp`) and Racional USD (`import:panel|kind=usd|key=usd`) move
-- from Brokerage › Cash to Efectivo › Cash savings, each on its own leaf asset group — the
-- shape the Fintual balance accounts took on 2026-10-05 (`cash_eqs__cash_savings__fintual_*`).
-- With them gone the Brokerage › Cash bucket holds nothing (the IPSA caja sits under the
-- portfolio unit's own asset group since migration 192), so the bucket goes: its asset groups
-- (with any account-less leaf left under them), its portfolio group and that group's items.
-- `seedNavTree` and `SEED_ASSET_GROUPS` no longer create it; a fresh DB never has it.
--
-- Keyed on slugs and import keys: a DB without those accounts moves nothing and only drops
-- the empty bucket; the account items are relinked under Cash savings by the next seed.

INSERT INTO asset_groups (slug, label, sort_order, parent_id)
SELECT 'cash_eqs__cash_savings__racional_clp__clp', 'Racional CLP', 35,
       (SELECT id FROM asset_groups WHERE slug = 'cash_eqs__cash_savings')
WHERE EXISTS (SELECT 1 FROM accounts WHERE import_key = 'import:panel|kind=clp|key=clp')
  AND EXISTS (SELECT 1 FROM asset_groups WHERE slug = 'cash_eqs__cash_savings')
  AND NOT EXISTS (SELECT 1 FROM asset_groups WHERE slug = 'cash_eqs__cash_savings__racional_clp__clp');

INSERT INTO asset_groups (slug, label, sort_order, parent_id)
SELECT 'cash_eqs__cash_savings__racional_usd__usd', 'Racional USD', 36,
       (SELECT id FROM asset_groups WHERE slug = 'cash_eqs__cash_savings')
WHERE EXISTS (SELECT 1 FROM accounts WHERE import_key = 'import:panel|kind=usd|key=usd')
  AND EXISTS (SELECT 1 FROM asset_groups WHERE slug = 'cash_eqs__cash_savings')
  AND NOT EXISTS (SELECT 1 FROM asset_groups WHERE slug = 'cash_eqs__cash_savings__racional_usd__usd');

UPDATE accounts
SET asset_group_id = (SELECT id FROM asset_groups WHERE slug = 'cash_eqs__cash_savings__racional_clp__clp'),
    primary_portfolio_group_id = (SELECT id FROM portfolio_groups WHERE slug = 'cash_savings')
WHERE import_key = 'import:panel|kind=clp|key=clp'
  AND EXISTS (SELECT 1 FROM asset_groups WHERE slug = 'cash_eqs__cash_savings__racional_clp__clp')
  AND EXISTS (SELECT 1 FROM portfolio_groups WHERE slug = 'cash_savings');

UPDATE accounts
SET asset_group_id = (SELECT id FROM asset_groups WHERE slug = 'cash_eqs__cash_savings__racional_usd__usd'),
    primary_portfolio_group_id = (SELECT id FROM portfolio_groups WHERE slug = 'cash_savings')
WHERE import_key = 'import:panel|kind=usd|key=usd'
  AND EXISTS (SELECT 1 FROM asset_groups WHERE slug = 'cash_eqs__cash_savings__racional_usd__usd')
  AND EXISTS (SELECT 1 FROM portfolio_groups WHERE slug = 'cash_savings');

-- Their old memberships; the next seed links them under Cash savings.
DELETE FROM portfolio_group_items
WHERE item_kind = 'account'
  AND account_id IN (
    SELECT id FROM accounts
    WHERE import_key IN ('import:panel|kind=clp|key=clp', 'import:panel|kind=usd|key=usd')
  );

-- The empty bucket: account-less leaves under Brokerage › Cash first (its USD / CLP leaves,
-- and fixtures tests left behind), then the bucket itself once nothing hangs from it.
DELETE FROM asset_groups
WHERE parent_id = (SELECT id FROM asset_groups WHERE slug = 'brokerage_cash')
  AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.asset_group_id = asset_groups.id)
  AND NOT EXISTS (SELECT 1 FROM asset_groups c WHERE c.parent_id = asset_groups.id);

DELETE FROM asset_groups
WHERE slug = 'brokerage_cash'
  AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.asset_group_id = asset_groups.id)
  AND NOT EXISTS (SELECT 1 FROM asset_groups c WHERE c.parent_id = asset_groups.id);

DELETE FROM portfolio_group_items
WHERE (group_id = (SELECT id FROM portfolio_groups WHERE slug = 'brokerage_cash')
       OR child_group_id = (SELECT id FROM portfolio_groups WHERE slug = 'brokerage_cash'))
  AND NOT EXISTS (SELECT 1 FROM asset_groups WHERE slug = 'brokerage_cash');

UPDATE accounts
SET primary_portfolio_group_id = NULL
WHERE primary_portfolio_group_id = (SELECT id FROM portfolio_groups WHERE slug = 'brokerage_cash')
  AND NOT EXISTS (SELECT 1 FROM asset_groups WHERE slug = 'brokerage_cash');

DELETE FROM portfolio_groups
WHERE slug = 'brokerage_cash'
  AND NOT EXISTS (SELECT 1 FROM asset_groups WHERE slug = 'brokerage_cash')
  AND NOT EXISTS (SELECT 1 FROM portfolio_groups c WHERE c.parent_id = portfolio_groups.id);
