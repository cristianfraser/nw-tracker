-- SOXX and SOXQ track the same semiconductor index (one bought at Racional, the other at
-- Fintual), so they read as one «SOXX» unit under Acciones, like the IPSA unit (190, 192–194):
-- a bucket backed by its own asset group, with the two leaf asset groups reparented under it
-- (leaf slugs, and so each account's behavior kind, unchanged). `seedNavTree` links it as a
-- child group of Acciones beside the other stocks.
--
-- Keyed on the accounts' import keys; a DB without them (demo, CI, fresh) gets nothing.

INSERT INTO asset_groups (slug, label, sort_order, parent_id)
SELECT 'brokerage_soxx', 'SOXX', 37, b.id
FROM asset_groups b
WHERE b.slug = 'brokerage_acciones'
  AND EXISTS (SELECT 1 FROM accounts WHERE import_key = 'import:panel|ticker=SOXX|key=soxx')
  AND EXISTS (SELECT 1 FROM accounts WHERE import_key = 'import:panel|ticker=SOXQ|key=soxq')
  AND NOT EXISTS (SELECT 1 FROM asset_groups WHERE slug = 'brokerage_soxx');

UPDATE asset_groups
SET parent_id = (SELECT id FROM asset_groups WHERE slug = 'brokerage_soxx')
WHERE id IN (
    SELECT asset_group_id FROM accounts
    WHERE import_key IN (
      'import:panel|ticker=SOXX|key=soxx',
      'import:panel|ticker=SOXQ|key=soxq'
    )
  )
  AND EXISTS (SELECT 1 FROM asset_groups WHERE slug = 'brokerage_soxx');

INSERT INTO portfolio_groups (
  parent_id, slug, label, sort_order, route_path, active_prefix, nav_end, show_leaf_hyphen,
  api_group, api_subgroup, asset_group_slug, sidebar_section, group_kind, kind_slug,
  exclude_from_parent_total
)
SELECT p.id, 'brokerage_soxx', 'SOXX', 26,
       '/inversiones/brokerage/acciones/soxx', '/inversiones/brokerage/acciones/soxx', 0, 1,
       'brokerage', 'soxx', 'brokerage_soxx', 'nested', 'bucket', 'soxx', 0
FROM portfolio_groups p
WHERE p.slug = 'brokerage_acciones'
  AND EXISTS (SELECT 1 FROM asset_groups WHERE slug = 'brokerage_soxx')
  AND NOT EXISTS (SELECT 1 FROM portfolio_groups WHERE slug = 'brokerage_soxx');
