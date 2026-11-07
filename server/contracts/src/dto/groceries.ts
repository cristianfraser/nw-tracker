/** DTOs for /api/groceries/* (server: groceryProducts.ts). */

export type UnclassifiedGroup = {
  store_chain: string;
  barcode: string | null;
  description: string;
  occurrences: number;
  last_seen: string;
  qty_unit: string;
  last_unit_price_clp: number;
  total_spent_clp: number;
  suggestions: { product_id: number; product_name: string; via: string; score: number }[];
};

export type GroceryProductRow = {
  id: number;
  name: string;
  base_unit: string;
  alias_count: number;
  purchase_count: number;
  last_purchased_at: string | null;
  last_effective_unit_price_clp: number | null;
};

/** Document that owns a receipt row — the `store.receipt` document kinds (server/contracts). */
export type GroceryReceiptSource = "email" | "pdf" | "photo";

export type GroceryReceiptRow = {
  id: number;
  purchased_at: string;
  source: GroceryReceiptSource;
  store_chain: string;
  branch: string;
  city: string | null;
  total_clp: number;
  card_paid_clp: number;
  payments: { method: string; amount_clp: number }[];
  /** Card-line outcome: pending_branch = flagged, waiting for the bank's own line to pair it. */
  card_line_status: "created" | "covered" | "pending_branch" | "matched" | null;
  item_count: number;
  classified_count: number;
};

export type GroceryReceiptItemRow = {
  id: number;
  position: number;
  barcode: string | null;
  description: string;
  qty: string;
  qty_unit: string;
  unit_price_clp: number;
  total_clp: number;
  discount_clp: number;
  product_id: number | null;
  product_name: string | null;
  product_source: string | null;
};

export type ProductHistoryRow = {
  purchased_at: string;
  store_chain: string;
  branch: string;
  city: string | null;
  description: string;
  qty: string;
  qty_unit: string;
  unit_price_clp: number;
  effective_unit_price_clp: number;
  total_clp: number;
  discount_clp: number;
  brand_name: string | null;
  normalized_unit_price_clp: number | null;
};

export type GroceriesSummary = {
  unclassified: UnclassifiedGroup[];
  products: GroceryProductRow[];
  receipts: GroceryReceiptRow[];
};

export type GroceryBaseUnit = "un" | "g" | "kg" | "ml" | "l" | "m";

export type GroceryProductAliasConfigRow = {
  id: number;
  store_chain: string;
  barcode: string | null;
  description: string | null;
  sample_description: string | null;
  last_seen: string | null;
  purchase_count: number;
  brand_id: number | null;
  brand_name: string | null;
  /** Canonical small-unit content (g/ml/m); null = unconfigured. */
  content: number | null;
};

export type GroceryProductDetail = {
  id: number;
  name: string;
  base_unit: GroceryBaseUnit;
  aliases: GroceryProductAliasConfigRow[];
};

export type GroceryBrandRow = { id: number; name: string; alias_count: number };
