-- Supermarket receipts with item detail, store-agnostic with frozen provenance.
--
-- The canonical layer is `grocery_products` (what "the same product" means regardless of store
-- or printed name). `grocery_product_aliases` maps a printed identity — barcode when the receipt
-- prints one, else the description — to a product, scoped per store chain so a string collision
-- between chains can never silently merge two different products. Items STAMP their resolved
-- product_id at classification time (`product_source` 'alias' | 'manual'); the alias table is
-- only the forward-looking rule, which is what keeps history intact when a generic printed name
-- is later re-pointed at a different product.
--
-- Receipts freeze provenance at import: chain, branch (the boleta's SUC line), city (printed on
-- the boleta), local purchase datetime, payment method/amounts. Today's only source is the Lider
-- «Boleta Digital» e-mail (source 'lider_email'); a future chain is a new importer writing these
-- same tables.

CREATE TABLE IF NOT EXISTS grocery_products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS grocery_product_aliases (
  id INTEGER PRIMARY KEY,
  store_chain TEXT NOT NULL,
  -- Barcode-keyed alias when the receipt prints one (aliases with barcode NULL key on the
  -- description). One of the two identities per row.
  barcode TEXT,
  description TEXT,
  product_id INTEGER NOT NULL REFERENCES grocery_products(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((barcode IS NOT NULL) + (description IS NOT NULL) = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_grocery_alias_barcode
  ON grocery_product_aliases(store_chain, barcode) WHERE barcode IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_grocery_alias_description
  ON grocery_product_aliases(store_chain, description) WHERE description IS NOT NULL;

CREATE TABLE IF NOT EXISTS grocery_receipts (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  -- Stable per-document identity from the source (the e-mail message id for lider_email).
  source_key TEXT NOT NULL UNIQUE,
  receipt_number TEXT NOT NULL,
  store_chain TEXT NOT NULL,
  branch TEXT NOT NULL,
  city TEXT,
  -- Local (Chile) datetime printed on the receipt: 'YYYY-MM-DD HH:MM:SS'.
  purchased_at TEXT NOT NULL,
  total_clp INTEGER NOT NULL,
  discount_total_clp INTEGER NOT NULL DEFAULT 0,
  -- JSON array of payment legs [{method, amount_clp}]; card_paid_clp is the card leg's sum.
  payments_json TEXT NOT NULL,
  card_paid_clp INTEGER NOT NULL DEFAULT 0,
  mi_club_points INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_grocery_receipts_purchased ON grocery_receipts(purchased_at);

CREATE TABLE IF NOT EXISTS grocery_receipt_items (
  id INTEGER PRIMARY KEY,
  receipt_id INTEGER NOT NULL REFERENCES grocery_receipts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  barcode TEXT,
  description TEXT NOT NULL,
  -- Decimal string: '3' for unit items, '1.744' for weighted ones.
  qty TEXT NOT NULL,
  qty_unit TEXT NOT NULL CHECK (qty_unit IN ('un', 'kg')),
  -- List unit price; for kg items the derived per-kg price (total / weight).
  unit_price_clp INTEGER NOT NULL,
  total_clp INTEGER NOT NULL,
  discount_clp INTEGER NOT NULL DEFAULT 0,
  discount_labels_json TEXT,
  product_id INTEGER REFERENCES grocery_products(id) ON DELETE SET NULL,
  product_source TEXT CHECK (product_source IN ('alias', 'manual')),
  UNIQUE (receipt_id, position),
  CHECK ((product_id IS NULL) = (product_source IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_grocery_items_product ON grocery_receipt_items(product_id);
CREATE INDEX IF NOT EXISTS idx_grocery_items_unclassified
  ON grocery_receipt_items(description) WHERE product_id IS NULL;
