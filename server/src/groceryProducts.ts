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
        last_unit_price_clp: row.unit_price_clp,
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
        existing.last_unit_price_clp = row.unit_price_clp;
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
      `SELECT p.id, p.name,
              (SELECT COUNT(*) FROM grocery_product_aliases a WHERE a.product_id = p.id) AS alias_count,
              (SELECT COUNT(*) FROM grocery_receipt_items i WHERE i.product_id = p.id) AS purchase_count,
              (SELECT MAX(r.purchased_at) FROM grocery_receipt_items i
                JOIN grocery_receipts r ON r.id = i.receipt_id
                WHERE i.product_id = p.id) AS last_purchased_at,
              (SELECT CAST(ROUND((i.total_clp - i.discount_clp) / CAST(i.qty AS REAL)) AS INTEGER)
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
};

export function groceryProductHistory(productId: number): ProductHistoryRow[] {
  const rows = db
    .prepare(
      `SELECT r.purchased_at, r.store_chain, r.branch, r.city, i.description, i.qty, i.qty_unit,
              i.unit_price_clp, i.total_clp, i.discount_clp
       FROM grocery_receipt_items i
       JOIN grocery_receipts r ON r.id = i.receipt_id
       WHERE i.product_id = ?
       ORDER BY r.purchased_at`
    )
    .all(productId) as Omit<ProductHistoryRow, "effective_unit_price_clp">[];
  return rows.map((r) => ({
    ...r,
    effective_unit_price_clp: Math.round((r.total_clp - r.discount_clp) / Number(r.qty)),
  }));
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
