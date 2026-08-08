-- Receipt-level discounts are not product info. A rebate that applies to the whole boleta —
-- Mi Club points redeemed (RF CANJE PESOS MCL), a 10% card coupon — must not ride on any
-- item's discount_clp, or that product's effective price history is corrupted (an ARROZ at
-- $2.490 was carrying a $1x.xxx "discount"). Parser v2 splits the scopes; these columns hold
-- the receipt-level side. `discount_total_clp` remains Σ item-level discounts only.
ALTER TABLE grocery_receipts ADD COLUMN receipt_discount_clp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE grocery_receipts ADD COLUMN receipt_discounts_json TEXT;
