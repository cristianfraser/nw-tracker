-- A portfolio group declared as a basket (a managed set of holdings shown as one position, e.g. the
-- IPSA and SOXX portfolios). Declared from the panel's group editor; no shape rule infers it.
ALTER TABLE portfolio_groups ADD COLUMN basket INTEGER NOT NULL DEFAULT 0 CHECK (basket IN (0, 1));

UPDATE portfolio_groups SET basket = 1 WHERE slug IN ('brokerage_portafolio_ipsa', 'brokerage_soxx');
