-- A managed portfolio is one product: its holding and the caja the broker charges the
-- portfolio fee from. Filed apart (holding under brokerage_acciones, caja under
-- brokerage_cash) the fee read as a large monthly loss on a small cash account and never
-- reached the holding's return. A portfolio unit is a brokerage bucket backed by its own
-- asset group, and the members' leaf asset groups are REPARENTED under it (leaf slugs, and
-- therefore each account's behavior kind, stay exactly as they were). `seedNavTree` links
-- every such bucket from data (`portfolio_groups.asset_group_slug`), so another portfolio
-- is the same three rows, no code.
--
-- Keyed on the accounts' import keys; a DB without them (demo, CI, fresh) gets nothing.

INSERT INTO asset_groups (slug, label, sort_order, parent_id)
SELECT 'brokerage_portafolio_ipsa', 'Portafolio IPSA', 35, b.id
FROM asset_groups b
WHERE b.slug = 'brokerage'
  AND EXISTS (SELECT 1 FROM accounts WHERE import_key = 'import:panel|ticker=CFIETFIPSA.SN|key=cfietfipsa_sn')
  AND EXISTS (SELECT 1 FROM accounts WHERE import_key = 'import:panel|kind=clp|key=caja_portafolio_ipsa')
  AND NOT EXISTS (SELECT 1 FROM asset_groups WHERE slug = 'brokerage_portafolio_ipsa');

UPDATE asset_groups
SET parent_id = (SELECT id FROM asset_groups WHERE slug = 'brokerage_portafolio_ipsa')
WHERE id IN (
    SELECT asset_group_id FROM accounts
    WHERE import_key IN (
      'import:panel|ticker=CFIETFIPSA.SN|key=cfietfipsa_sn',
      'import:panel|kind=clp|key=caja_portafolio_ipsa'
    )
  )
  AND EXISTS (SELECT 1 FROM asset_groups WHERE slug = 'brokerage_portafolio_ipsa');

INSERT INTO portfolio_groups (
  parent_id, slug, label, sort_order, route_path, active_prefix, nav_end, show_leaf_hyphen,
  api_group, api_subgroup, asset_group_slug, sidebar_section, group_kind, kind_slug,
  exclude_from_parent_total
)
SELECT p.id, 'brokerage_portafolio_ipsa', 'Portafolio IPSA', 25,
       '/inversiones/brokerage/portafolio-ipsa', '/inversiones/brokerage/portafolio-ipsa', 0, 1,
       'brokerage', 'portafolio_ipsa', 'brokerage_portafolio_ipsa', 'nested', 'bucket',
       'portafolio_ipsa', 0
FROM portfolio_groups p
WHERE p.slug = 'brokerage'
  AND EXISTS (SELECT 1 FROM asset_groups WHERE slug = 'brokerage_portafolio_ipsa')
  AND NOT EXISTS (SELECT 1 FROM portfolio_groups WHERE slug = 'brokerage_portafolio_ipsa');
