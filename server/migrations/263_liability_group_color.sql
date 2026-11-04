-- Pasivos groups (tarjeta de crédito, hipoteca) take a colour like a portfolio group: an explicit
-- one set from the panel, else their largest member's (the nav tree resolves it).
ALTER TABLE liability_groups ADD COLUMN color_rgb TEXT;
