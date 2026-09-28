-- The Portafolio IPSA unit (migration 190) is an equity product: file it under Acciones
-- instead of beside it. Both its asset group and its portfolio group move under
-- brokerage_acciones; `seedNavTree` links a bucket's nested buckets as child groups beside its
-- own accounts, so Acciones holds its stocks and the unit side by side and each account stays
-- in exactly one group. The unit's route moves under Acciones (the old URL is not kept).
--
-- Keyed on the slugs; a DB without the unit (demo, CI, fresh) gets nothing.

UPDATE asset_groups
SET parent_id = (SELECT id FROM asset_groups WHERE slug = 'brokerage_acciones')
WHERE slug = 'brokerage_portafolio_ipsa'
  AND EXISTS (SELECT 1 FROM asset_groups WHERE slug = 'brokerage_acciones');

UPDATE portfolio_groups
SET parent_id = (SELECT id FROM portfolio_groups WHERE slug = 'brokerage_acciones'),
    route_path = '/inversiones/brokerage/acciones/portafolio-ipsa',
    active_prefix = '/inversiones/brokerage/acciones/portafolio-ipsa'
WHERE slug = 'brokerage_portafolio_ipsa'
  AND EXISTS (SELECT 1 FROM portfolio_groups WHERE slug = 'brokerage_acciones');

-- The unit's old membership under brokerage; the next seed relinks it under Acciones.
DELETE FROM portfolio_group_items
WHERE item_kind = 'group'
  AND group_id = (SELECT id FROM portfolio_groups WHERE slug = 'brokerage')
  AND child_group_id = (SELECT id FROM portfolio_groups WHERE slug = 'brokerage_portafolio_ipsa');
