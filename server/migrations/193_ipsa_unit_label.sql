-- The Portafolio IPSA unit reads «IPSA» among Acciones' stocks (sidebar, table, chart lines).
-- Label only: the slug is the node's stable id and the route keeps its path.

UPDATE portfolio_groups SET label = 'IPSA' WHERE slug = 'brokerage_portafolio_ipsa';
UPDATE asset_groups SET label = 'IPSA' WHERE slug = 'brokerage_portafolio_ipsa';
