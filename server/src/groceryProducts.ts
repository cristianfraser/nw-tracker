/**
 * Grocery catalog: summary payloads, classification (aliases + stamping), price history.
 *
 * Classification model (see migration 172): `grocery_receipt_items.product_id` is STAMPED —
 * an alias is only the forward rule, so re-pointing an alias later never rewrites history.
 * The classification unit is the alias identity: items with a barcode group by
 * (chain, barcode); barcode-less items group by (chain, description). Assigning a group
 * upserts its alias and stamps every currently-unclassified item it covers; stamps are never
 * overwritten by alias assignment (`product_id IS NULL` guard), and manual stamps outrank
 * alias ones by construction.
 */
import { db } from "./db.js";

export type UnclassifiedGroup = {
  store_chain: string;
  /** Alias identity: barcode when present, else null and `description` is the identity. */
  barcode: string | null;
  /** Latest printed description for the group (barcode groups can carry several variants). */
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

export type GroceryReceiptRow = {
  id: number;
  purchased_at: string;
  store_chain: string;
  branch: string;
  city: string | null;
  total_clp: number;
  card_paid_clp: number;
  payments: { method: string; amount_clp: number }[];
  item_count: number;
  classified_count: number;
};

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toUpperCase()
      .replace(/[^A-Z0-9ÑÁÉÍÓÚ]+/g, " ")
      .split(" ")
      .filter((t) => t.length >= 2)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Top classified-alias name matches for an unclassified description (same chain first). */
function suggestionsFor(
  description: string,
  aliasPool: { store_chain: string; text: string; product_id: number; product_name: string }[],
  chain: string
): UnclassifiedGroup["suggestions"] {
  const target = tokens(description);
  const scored = aliasPool
    .map((a) => ({
      product_id: a.product_id,
      product_name: a.product_name,
      via: a.text,
      score: jaccard(target, tokens(a.text)) + (a.store_chain === chain ? 0.05 : 0),
    }))
    .filter((s) => s.score >= 0.34);
  scored.sort((x, y) => y.score - x.score);
  const seen = new Set<number>();
  const out: UnclassifiedGroup["suggestions"] = [];
  for (const s of scored) {
    if (seen.has(s.product_id)) continue;
    seen.add(s.product_id);
    out.push({ ...s, score: Math.round(s.score * 100) / 100 });
    if (out.length === 3) break;
  }
  return out;
}

export function listUnclassifiedGroups(): UnclassifiedGroup[] {
  const rows = db
    .prepare(
      `SELECT r.store_chain, i.barcode, i.description, i.qty_unit, i.unit_price_clp,
              i.total_clp, i.discount_clp, r.purchased_at
       FROM grocery_receipt_items i
       JOIN grocery_receipts r ON r.id = i.receipt_id
       WHERE i.product_id IS NULL
       ORDER BY r.purchased_at`
    )
    .all() as {
    store_chain: string;
    barcode: string | null;
    description: string;
    qty_unit: string;
    unit_price_clp: number;
    total_clp: number;
    discount_clp: number;
    purchased_at: string;
  }[];

  const groups = new Map<string, UnclassifiedGroup>();
  for (const row of rows) {
    const key = row.barcode
      ? `${row.store_chain}|b|${row.barcode}`
      : `${row.store_chain}|d|${row.description}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        store_chain: row.store_chain,
        barcode: row.barcode,
        description: row.description,
        occurrences: 1,
        last_seen: row.purchased_at,
        qty_unit: row.qty_unit,
        // Weighed rows: the paid amount, not the per-kg rate — per-unit pricing is the
        // product config's job, not the raw feed's.
        last_unit_price_clp:
          row.qty_unit === "kg" ? row.total_clp - row.discount_clp : row.unit_price_clp,
        total_spent_clp: row.total_clp - row.discount_clp,
        suggestions: [],
      });
    } else {
      existing.occurrences += 1;
      existing.total_spent_clp += row.total_clp - row.discount_clp;
      if (row.purchased_at >= existing.last_seen) {
        existing.last_seen = row.purchased_at;
        existing.description = row.description;
        existing.qty_unit = row.qty_unit;
        existing.last_unit_price_clp =
          row.qty_unit === "kg" ? row.total_clp - row.discount_clp : row.unit_price_clp;
      }
    }
  }

  const aliasPool = db
    .prepare(
      `SELECT a.store_chain, COALESCE(a.description, a.barcode) AS text, a.product_id, p.name AS product_name
       FROM grocery_product_aliases a JOIN grocery_products p ON p.id = a.product_id`
    )
    .all() as { store_chain: string; text: string; product_id: number; product_name: string }[];
  // Product names themselves are match targets too — the catalog is small and a product with
  // only barcode aliases would otherwise never be suggested.
  const products = db.prepare(`SELECT id, name FROM grocery_products`).all() as {
    id: number;
    name: string;
  }[];
  const pool = [
    ...aliasPool,
    ...products.map((p) => ({ store_chain: "", text: p.name, product_id: p.id, product_name: p.name })),
  ];

  const out = [...groups.values()];
  for (const g of out) {
    g.suggestions = suggestionsFor(g.description, pool, g.store_chain);
  }
  out.sort((a, b) => b.occurrences - a.occurrences || (a.last_seen < b.last_seen ? 1 : -1));
  return out;
}

export function listGroceryProducts(): GroceryProductRow[] {
  return db
    .prepare(
      `SELECT p.id, p.name, p.base_unit,
              (SELECT COUNT(*) FROM grocery_product_aliases a WHERE a.product_id = p.id) AS alias_count,
              (SELECT COUNT(*) FROM grocery_receipt_items i WHERE i.product_id = p.id) AS purchase_count,
              (SELECT MAX(r.purchased_at) FROM grocery_receipt_items i
                JOIN grocery_receipts r ON r.id = i.receipt_id
                WHERE i.product_id = p.id) AS last_purchased_at,
              (SELECT CASE WHEN i.qty_unit = 'kg' THEN i.total_clp - i.discount_clp
                           ELSE CAST(ROUND((i.total_clp - i.discount_clp) / CAST(i.qty AS REAL)) AS INTEGER) END
                 FROM grocery_receipt_items i
                 JOIN grocery_receipts r ON r.id = i.receipt_id
                 WHERE i.product_id = p.id
                 ORDER BY r.purchased_at DESC LIMIT 1) AS last_effective_unit_price_clp
       FROM grocery_products p
       ORDER BY p.name`
    )
    .all() as GroceryProductRow[];
}

export function listGroceryReceipts(): GroceryReceiptRow[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.purchased_at, r.store_chain, r.branch, r.city, r.total_clp, r.card_paid_clp,
              r.payments_json,
              (SELECT COUNT(*) FROM grocery_receipt_items i WHERE i.receipt_id = r.id) AS item_count,
              (SELECT COUNT(*) FROM grocery_receipt_items i
                WHERE i.receipt_id = r.id AND i.product_id IS NOT NULL) AS classified_count
       FROM grocery_receipts r
       ORDER BY r.purchased_at DESC`
    )
    .all() as (Omit<GroceryReceiptRow, "payments"> & { payments_json: string })[];
  return rows.map(({ payments_json, ...row }) => ({
    ...row,
    payments: JSON.parse(payments_json) as GroceryReceiptRow["payments"],
  }));
}

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

export function listGroceryReceiptItems(receiptId: number): GroceryReceiptItemRow[] {
  return db
    .prepare(
      `SELECT i.id, i.position, i.barcode, i.description, i.qty, i.qty_unit, i.unit_price_clp,
              i.total_clp, i.discount_clp, i.product_id, p.name AS product_name, i.product_source
       FROM grocery_receipt_items i
       LEFT JOIN grocery_products p ON p.id = i.product_id
       WHERE i.receipt_id = ?
       ORDER BY i.position`
    )
    .all(receiptId) as GroceryReceiptItemRow[];
}

export type ProductHistoryRow = {
  purchased_at: string;
  store_chain: string;
  branch: string;
  city: string | null;
  description: string;
  qty: string;
  qty_unit: string;
  /** List unit price as printed (kg items: derived per-kg). */
  unit_price_clp: number;
  /** After per-line discounts: (total - discount) / qty. */
  effective_unit_price_clp: number;
  total_clp: number;
  discount_clp: number;
  brand_name: string | null;
  /**
   * Effective price per the product's base unit ($/kg, $/L, $/m …); null when the row's alias
   * has no content configured (never guessed) or the row's shape doesn't map to the dimension.
   */
  normalized_unit_price_clp: number | null;
};

export function groceryProductHistory(productId: number): ProductHistoryRow[] {
  const product = db
    .prepare(`SELECT base_unit FROM grocery_products WHERE id = ?`)
    .get(productId) as { base_unit: GroceryBaseUnit } | undefined;
  const baseUnit = product?.base_unit ?? "un";
  const rows = db
    .prepare(
      `SELECT r.purchased_at, r.store_chain, r.branch, r.city, i.description, i.qty, i.qty_unit,
              i.unit_price_clp, i.total_clp, i.discount_clp,
              b.name AS brand_name, a.content AS alias_content
       FROM grocery_receipt_items i
       JOIN grocery_receipts r ON r.id = i.receipt_id
       LEFT JOIN grocery_product_aliases a ON a.store_chain = r.store_chain
         AND ((i.barcode IS NOT NULL AND a.barcode = i.barcode)
           OR (i.barcode IS NULL AND a.barcode IS NULL AND a.description = i.description))
       LEFT JOIN grocery_brands b ON b.id = a.brand_id
       WHERE i.product_id = ?
       ORDER BY r.purchased_at`
    )
    .all(productId) as (Omit<
    ProductHistoryRow,
    "effective_unit_price_clp" | "normalized_unit_price_clp"
  > & { alias_content: number | null })[];
  return rows.map(({ alias_content, ...r }) => {
    if (r.qty_unit === "kg") {
      // A weighed purchase has no fixed package: its "price" is what was paid for that weight,
      // and the per-kg rate exists ONLY through the product config (base_unit kg/g) — the
      // weight itself plays the content role, so no alias content is needed.
      const paid = r.total_clp - r.discount_clp;
      const perKg = Math.round(paid / Number(r.qty));
      const normalized =
        baseUnit === "kg" ? perKg : baseUnit === "g" ? Math.round(perKg / 1000) : null;
      return {
        ...r,
        unit_price_clp: r.total_clp,
        effective_unit_price_clp: paid,
        normalized_unit_price_clp: normalized,
      };
    }
    const effective = Math.round((r.total_clp - r.discount_clp) / Number(r.qty));
    return {
      ...r,
      effective_unit_price_clp: effective,
      normalized_unit_price_clp: normalizedUnitPrice(effective, baseUnit, alias_content),
    };
  });
}

export class GroceryAliasConflictError extends Error {}

export type ClassifyTarget = { barcode: string | null; description: string };

/**
 * Assign one or more unclassified groups to a product (existing, or created here from
 * `new_product_name`), in one transaction: upsert the aliases, stamp every currently
 * unclassified item each alias covers. Never overwrites a stamp. An alias that already
 * points at a DIFFERENT product refuses — re-pointing is a deliberate separate action.
 */
export function classifyGroceryGroups(input: {
  store_chain: string;
  targets: ClassifyTarget[];
  product_id?: number;
  new_product_name?: string;
}): { product_id: number; aliases: number; stamped: number } {
  if (input.targets.length === 0) throw new Error("classify: no targets");
  const run = db.transaction(() => {
    let productId = input.product_id ?? null;
    if (productId == null) {
      const name = String(input.new_product_name ?? "").trim();
      if (!name) throw new Error("classify: product_id or new_product_name required");
      const existing = db.prepare(`SELECT id FROM grocery_products WHERE name = ?`).get(name) as
        | { id: number }
        | undefined;
      productId =
        existing?.id ??
        Number(db.prepare(`INSERT INTO grocery_products (name) VALUES (?)`).run(name).lastInsertRowid);
    } else {
      const exists = db.prepare(`SELECT 1 AS x FROM grocery_products WHERE id = ?`).get(productId);
      if (!exists) throw new Error(`classify: no product ${productId}`);
    }

    let aliases = 0;
    let stamped = 0;
    for (const target of input.targets) {
      const barcode = target.barcode?.trim() || null;
      const description = String(target.description ?? "").trim();
      if (!barcode && !description) throw new Error("classify: target needs a barcode or description");

      const current = barcode
        ? (db
            .prepare(`SELECT product_id FROM grocery_product_aliases WHERE store_chain = ? AND barcode = ?`)
            .get(input.store_chain, barcode) as { product_id: number } | undefined)
        : (db
            .prepare(`SELECT product_id FROM grocery_product_aliases WHERE store_chain = ? AND description = ?`)
            .get(input.store_chain, description) as { product_id: number } | undefined);
      if (current && current.product_id !== productId) {
        throw new GroceryAliasConflictError(
          `alias ${barcode ?? description} already points at product ${current.product_id}`
        );
      }
      if (!current) {
        db.prepare(
          `INSERT INTO grocery_product_aliases (store_chain, barcode, description, product_id)
           VALUES (?, ?, ?, ?)`
        ).run(input.store_chain, barcode, barcode ? null : description, productId);
        aliases += 1;
      }

      const res = barcode
        ? db
            .prepare(
              `UPDATE grocery_receipt_items SET product_id = ?, product_source = 'alias'
               WHERE product_id IS NULL AND barcode = ?
                 AND receipt_id IN (SELECT id FROM grocery_receipts WHERE store_chain = ?)`
            )
            .run(productId, barcode, input.store_chain)
        : db
            .prepare(
              `UPDATE grocery_receipt_items SET product_id = ?, product_source = 'alias'
               WHERE product_id IS NULL AND barcode IS NULL AND description = ?
                 AND receipt_id IN (SELECT id FROM grocery_receipts WHERE store_chain = ?)`
            )
            .run(productId, description, input.store_chain);
      stamped += res.changes;
    }
    return { product_id: productId, aliases, stamped };
  });
  return run();
}

// ── Product config: base units, global brands, alias contents, merge ──────────────────────────

export type GroceryBaseUnit = "un" | "g" | "kg" | "ml" | "l" | "m";

type UnitDimension = "count" | "mass" | "volume" | "length";

const UNIT_DIMENSION: Record<GroceryBaseUnit, UnitDimension> = {
  un: "count",
  g: "mass",
  kg: "mass",
  ml: "volume",
  l: "volume",
  m: "length",
};

/** Factor from a unit to its dimension's CANONICAL small unit (g / ml / m / un). */
const CANONICAL_FACTOR: Record<GroceryBaseUnit, number> = {
  un: 1,
  g: 1,
  kg: 1000,
  ml: 1,
  l: 1000,
  m: 1,
};

export function isGroceryBaseUnit(u: unknown): u is GroceryBaseUnit {
  return typeof u === "string" && u in UNIT_DIMENSION;
}

/** Content entered as value+unit → canonical amount, validated against the product's dimension. */
export function canonicalContent(
  value: number,
  unit: GroceryBaseUnit,
  baseUnit: GroceryBaseUnit
): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid content value ${value}`);
  if (UNIT_DIMENSION[unit] !== UNIT_DIMENSION[baseUnit] || baseUnit === "un") {
    throw new Error(`content unit ${unit} does not match the product's base unit ${baseUnit}`);
  }
  return value * CANONICAL_FACTOR[unit];
}

/** Effective package price → price per the product's display base unit; null when unknowable. */
export function normalizedUnitPrice(
  effectivePackagePriceClp: number,
  baseUnit: GroceryBaseUnit,
  contentCanonical: number | null
): number | null {
  if (baseUnit === "un") return effectivePackagePriceClp;
  if (contentCanonical == null || contentCanonical <= 0) return null;
  return Math.round((effectivePackagePriceClp / contentCanonical) * CANONICAL_FACTOR[baseUnit]);
}

export type GroceryBrandRow = { id: number; name: string; alias_count: number };

export function listGroceryBrands(): GroceryBrandRow[] {
  return db
    .prepare(
      `SELECT b.id, b.name,
              (SELECT COUNT(*) FROM grocery_product_aliases a WHERE a.brand_id = b.id) AS alias_count
       FROM grocery_brands b ORDER BY b.name`
    )
    .all() as GroceryBrandRow[];
}

/** Global catalog pick-or-create: names are unique, «Soprole» is one entity everywhere. */
export function ensureGroceryBrand(name: string): number {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("brand name required");
  const existing = db.prepare(`SELECT id FROM grocery_brands WHERE name = ?`).get(trimmed) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;
  return Number(db.prepare(`INSERT INTO grocery_brands (name) VALUES (?)`).run(trimmed).lastInsertRowid);
}

export function renameGroceryBrand(id: number, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("brand name required");
  const res = db.prepare(`UPDATE grocery_brands SET name = ? WHERE id = ?`).run(trimmed, id);
  if (res.changes !== 1) throw new Error(`no brand ${id}`);
}

export function deleteGroceryBrand(id: number): void {
  const used = db
    .prepare(`SELECT COUNT(*) AS c FROM grocery_product_aliases WHERE brand_id = ?`)
    .get(id) as { c: number };
  if (used.c > 0) throw new Error(`brand ${id} is referenced by ${used.c} alias(es)`);
  const res = db.prepare(`DELETE FROM grocery_brands WHERE id = ?`).run(id);
  if (res.changes !== 1) throw new Error(`no brand ${id}`);
}

export type GroceryProductAliasConfigRow = {
  id: number;
  store_chain: string;
  barcode: string | null;
  description: string | null;
  /** Latest printed description covered by this alias (barcode aliases carry name variants). */
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

export function groceryProductDetail(productId: number): GroceryProductDetail {
  const product = db
    .prepare(`SELECT id, name, base_unit FROM grocery_products WHERE id = ?`)
    .get(productId) as { id: number; name: string; base_unit: GroceryBaseUnit } | undefined;
  if (!product) throw new Error(`no product ${productId}`);
  const aliases = db
    .prepare(
      `SELECT a.id, a.store_chain, a.barcode, a.description, a.brand_id, b.name AS brand_name, a.content,
              (SELECT i.description FROM grocery_receipt_items i
                 JOIN grocery_receipts r ON r.id = i.receipt_id
                 WHERE r.store_chain = a.store_chain
                   AND ((a.barcode IS NOT NULL AND i.barcode = a.barcode)
                     OR (a.barcode IS NULL AND i.barcode IS NULL AND i.description = a.description))
                 ORDER BY r.purchased_at DESC LIMIT 1) AS sample_description,
              (SELECT MAX(r.purchased_at) FROM grocery_receipt_items i
                 JOIN grocery_receipts r ON r.id = i.receipt_id
                 WHERE r.store_chain = a.store_chain
                   AND ((a.barcode IS NOT NULL AND i.barcode = a.barcode)
                     OR (a.barcode IS NULL AND i.barcode IS NULL AND i.description = a.description))) AS last_seen,
              (SELECT COUNT(*) FROM grocery_receipt_items i
                 JOIN grocery_receipts r ON r.id = i.receipt_id
                 WHERE r.store_chain = a.store_chain
                   AND ((a.barcode IS NOT NULL AND i.barcode = a.barcode)
                     OR (a.barcode IS NULL AND i.barcode IS NULL AND i.description = a.description))) AS purchase_count
       FROM grocery_product_aliases a
       LEFT JOIN grocery_brands b ON b.id = a.brand_id
       WHERE a.product_id = ?
       ORDER BY a.store_chain, COALESCE(a.barcode, a.description)`
    )
    .all(productId) as GroceryProductAliasConfigRow[];
  return { ...product, aliases };
}

export function updateGroceryProductBaseUnit(productId: number, baseUnit: GroceryBaseUnit): void {
  const current = db
    .prepare(`SELECT base_unit FROM grocery_products WHERE id = ?`)
    .get(productId) as { base_unit: GroceryBaseUnit } | undefined;
  if (!current) throw new Error(`no product ${productId}`);
  const tx = db.transaction(() => {
    db.prepare(`UPDATE grocery_products SET base_unit = ? WHERE id = ?`).run(baseUnit, productId);
    // A dimension change makes stored contents meaningless (720 m is not 720 g) — clear them
    // rather than silently reinterpreting. Same-dimension scale changes keep contents (canonical).
    if (UNIT_DIMENSION[current.base_unit] !== UNIT_DIMENSION[baseUnit]) {
      db.prepare(`UPDATE grocery_product_aliases SET content = NULL WHERE product_id = ?`).run(productId);
    }
  });
  tx();
}

export function updateGroceryAliasConfig(
  aliasId: number,
  input: {
    /** Explicit brand id, a new/global brand name, or null to clear. */
    brand_id?: number | null;
    brand_name?: string;
    /** Content as entered (value + unit of the product's dimension), or null to clear. */
    content_value?: number | null;
    content_unit?: GroceryBaseUnit;
  }
): void {
  const alias = db
    .prepare(
      `SELECT a.id, p.base_unit FROM grocery_product_aliases a
       JOIN grocery_products p ON p.id = a.product_id WHERE a.id = ?`
    )
    .get(aliasId) as { id: number; base_unit: GroceryBaseUnit } | undefined;
  if (!alias) throw new Error(`no alias ${aliasId}`);

  const tx = db.transaction(() => {
    if (input.brand_name !== undefined) {
      db.prepare(`UPDATE grocery_product_aliases SET brand_id = ? WHERE id = ?`).run(
        ensureGroceryBrand(input.brand_name),
        aliasId
      );
    } else if (input.brand_id !== undefined) {
      if (input.brand_id != null) {
        const exists = db.prepare(`SELECT 1 AS x FROM grocery_brands WHERE id = ?`).get(input.brand_id);
        if (!exists) throw new Error(`no brand ${input.brand_id}`);
      }
      db.prepare(`UPDATE grocery_product_aliases SET brand_id = ? WHERE id = ?`).run(
        input.brand_id,
        aliasId
      );
    }
    if (input.content_value !== undefined) {
      if (input.content_value == null) {
        db.prepare(`UPDATE grocery_product_aliases SET content = NULL WHERE id = ?`).run(aliasId);
      } else {
        const unit = input.content_unit;
        if (!unit || !isGroceryBaseUnit(unit)) throw new Error("content_unit required with content_value");
        const canonical = canonicalContent(input.content_value, unit, alias.base_unit);
        db.prepare(`UPDATE grocery_product_aliases SET content = ? WHERE id = ?`).run(canonical, aliasId);
      }
    }
  });
  tx();
}

/**
 * Merge `sourceId` into `targetId`: aliases re-point wholesale — the global (chain, identity)
 * uniqueness means a source alias can never collide with a target one — ALL of the source's
 * stamped items restamp to the target (a merge is an identity statement, manual stamps
 * included), source product deleted.
 */
export function mergeGroceryProducts(
  sourceId: number,
  targetId: number
): { aliases_moved: number; items_restamped: number } {
  if (sourceId === targetId) throw new Error("cannot merge a product into itself");
  const run = db.transaction(() => {
    for (const id of [sourceId, targetId]) {
      if (!db.prepare(`SELECT 1 AS x FROM grocery_products WHERE id = ?`).get(id)) {
        throw new Error(`no product ${id}`);
      }
    }
    const moved = db
      .prepare(`UPDATE grocery_product_aliases SET product_id = ? WHERE product_id = ?`)
      .run(targetId, sourceId).changes;
    const restamped = db
      .prepare(`UPDATE grocery_receipt_items SET product_id = ? WHERE product_id = ?`)
      .run(targetId, sourceId).changes;
    db.prepare(`DELETE FROM grocery_products WHERE id = ?`).run(sourceId);
    return { aliases_moved: moved, items_restamped: restamped };
  });
  return run();
}
