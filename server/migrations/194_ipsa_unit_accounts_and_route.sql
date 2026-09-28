-- With the unit labelled «IPSA» (193), its members read by what they are: the ETF by its
-- ticker and the fee caja as the unit's caja; the route follows the label (the old URL is not
-- kept). Accounts are found by import key, never by name.

UPDATE accounts SET name = 'CFIETFIPSA'
WHERE import_key = 'import:panel|ticker=CFIETFIPSA.SN|key=cfietfipsa_sn';

UPDATE accounts SET name = 'Caja IPSA'
WHERE import_key = 'import:panel|kind=clp|key=caja_portafolio_ipsa';

UPDATE portfolio_groups
SET route_path = '/inversiones/brokerage/acciones/ipsa',
    active_prefix = '/inversiones/brokerage/acciones/ipsa'
WHERE slug = 'brokerage_portafolio_ipsa';
