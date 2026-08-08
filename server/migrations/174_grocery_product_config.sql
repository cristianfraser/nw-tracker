-- Product config for normalized price comparison.
--
-- `base_unit` is both the product's comparable dimension and its display scale: 'un' (default —
-- a product is one of itself), or g/kg (mass), ml/l (volume), m (length). Alias `content` is the
-- package size stored in the CANONICAL small unit of that dimension (g, ml, m) regardless of the
-- display scale, so switching kg↔g display never rewrites stored contents; normalized price =
-- effective package price / content, scaled to the display unit. NULL content = not configured
-- yet (normalized price unavailable, never guessed).
--
-- Brands are a GLOBAL catalog: one row per name («Soprole» is the same entity under leche and
-- yogurt); the product↔brand relation is derived from aliases, never stored.

ALTER TABLE grocery_products ADD COLUMN base_unit TEXT NOT NULL DEFAULT 'un'
  CHECK (base_unit IN ('un', 'g', 'kg', 'ml', 'l', 'm'));

CREATE TABLE IF NOT EXISTS grocery_brands (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE grocery_product_aliases ADD COLUMN brand_id INTEGER REFERENCES grocery_brands(id) ON DELETE SET NULL;
ALTER TABLE grocery_product_aliases ADD COLUMN content REAL CHECK (content IS NULL OR content > 0);
