import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { importStagedBoletas, resolveAliasProductId } from "./liderBoletasImport.js";
import {
  canonicalContent,
  deleteGroceryBrand,
  ensureGroceryBrand,
  mergeGroceryProducts,
  normalizedUnitPrice,
  updateGroceryAliasConfig,
  updateGroceryProductBaseUnit,
} from "./groceryProducts.js";

/**
 * Receipt/items/classification behavior, movement-free: synthetic boletas paid EFECTIVO skip
 * the card-movement branch entirely, so no CC master fixture is needed. Movement gating itself
 * is exercised by the real pipeline (closed-month/paid gates are thin date/amount guards).
 */

function syntheticStaged(dir: string, key: string, opts?: { description?: string; barcode?: string | null }) {
  const d = path.join(dir, key);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, "meta.json"),
    JSON.stringify({ message_id: `<${key}@vitest>`, subject: "Boleta Digital Lider", date: "2037-01-05T00:22:00Z", body_text: "" })
  );
  fs.writeFileSync(
    path.join(d, "parsed.json"),
    JSON.stringify({
      boleta_number: `9${key.replace(/\D/g, "")}01`,
      caja: "0001",
      sucursal: "CALLE FICTICIA #123",
      city: "COMUNA FICTICIA - SANTIAGO",
      purchased_at: "2037-01-04 20:11:22",
      template: "store",
      items: [
        {
          position: 0,
          barcode: opts?.barcode === undefined ? "7801234567890" : opts.barcode,
          description: opts?.description ?? "LECHE VITEST 1L",
          qty: "2",
          qty_unit: "un",
          unit_price_clp: 1500,
          total_clp: 3000,
          discount_clp: 500,
          discount_labels: ["RF Lleve N x $"],
        },
      ],
      payments: [{ method: "efectivo", amount_clp: 2500 }],
      total_printed_clp: 2500,
      articles_declared: 2,
      mi_club_points: null,
      parser_version: 1,
    })
  );
}

describe("liderBoletasImport", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    db.prepare(`DELETE FROM grocery_receipt_items WHERE receipt_id IN (SELECT id FROM grocery_receipts WHERE source_key LIKE '<vitest-%')`).run();
    db.prepare(`DELETE FROM grocery_receipts WHERE source_key LIKE '<vitest-%'`).run();
    db.prepare(`DELETE FROM grocery_product_aliases WHERE store_chain = 'vitest-chain' OR description LIKE 'LECHE VITEST%' OR barcode = '7801234567890'`).run();
    db.prepare(`DELETE FROM grocery_products WHERE name LIKE 'vitest %'`).run();
  });

  function tmpStagedDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-boletas-"));
    tmpDirs.push(d);
    return d;
  }

  it("imports a receipt with items, idempotently", () => {
    const staged = tmpStagedDir();
    syntheticStaged(staged, "vitest-a");
    const first = importStagedBoletas({ stagedDir: staged });
    expect(first).toHaveLength(1);
    expect(first[0]!.movement.status).toBe("not_card_paid");
    expect(first[0]!.items).toBe(1);

    const again = importStagedBoletas({ stagedDir: staged });
    expect(again[0]!.receipt_id).toBe(first[0]!.receipt_id);
    const rows = db
      .prepare(`SELECT COUNT(*) AS c FROM grocery_receipt_items WHERE receipt_id = ?`)
      .get(first[0]!.receipt_id) as { c: number };
    expect(rows.c).toBe(1);
    const receipt = db
      .prepare(`SELECT branch, city, purchased_at, total_clp, discount_total_clp, card_paid_clp FROM grocery_receipts WHERE id = ?`)
      .get(first[0]!.receipt_id) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      branch: "CALLE FICTICIA #123",
      city: "COMUNA FICTICIA - SANTIAGO",
      purchased_at: "2037-01-04 20:11:22",
      total_clp: 2500,
      discount_total_clp: 500,
      card_paid_clp: 0,
    });
  });

  it("classifies via barcode alias first, and re-import preserves the stamp", () => {
    db.prepare(`INSERT INTO grocery_products (name) VALUES ('vitest leche')`).run();
    const productId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    db.prepare(
      `INSERT INTO grocery_product_aliases (store_chain, barcode, product_id) VALUES ('lider', '7801234567890', ?)`
    ).run(productId);

    const staged = tmpStagedDir();
    syntheticStaged(staged, "vitest-b");
    const res = importStagedBoletas({ stagedDir: staged });
    expect(res[0]!.items_classified).toBe(1);
    const item = db
      .prepare(`SELECT product_id, product_source FROM grocery_receipt_items WHERE receipt_id = ?`)
      .get(res[0]!.receipt_id) as { product_id: number; product_source: string };
    expect(item.product_id).toBe(productId);
    expect(item.product_source).toBe("alias");

    // Alias later removed: the stamp survives a re-import (history is stamped, not derived).
    db.prepare(`DELETE FROM grocery_product_aliases WHERE product_id = ?`).run(productId);
    importStagedBoletas({ stagedDir: staged });
    const after = db
      .prepare(`SELECT product_id FROM grocery_receipt_items WHERE receipt_id = ?`)
      .get(res[0]!.receipt_id) as { product_id: number };
    expect(after.product_id).toBe(productId);
  });

  it("a changed printed description sends the item back to unclassified on re-import", () => {
    db.prepare(`INSERT INTO grocery_products (name) VALUES ('vitest leche 2')`).run();
    const productId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    db.prepare(
      `INSERT INTO grocery_product_aliases (store_chain, description, product_id) VALUES ('lider', 'LECHE VITEST 1L', ?)`
    ).run(productId);

    const staged = tmpStagedDir();
    syntheticStaged(staged, "vitest-c", { barcode: null });
    const res = importStagedBoletas({ stagedDir: staged });
    expect(res[0]!.items_classified).toBe(1);

    // Parser fix renames the line → the old stamp must not silently survive under new text.
    db.prepare(`DELETE FROM grocery_product_aliases WHERE product_id = ?`).run(productId);
    fs.rmSync(path.join(staged, "vitest-c"), { recursive: true });
    syntheticStaged(staged, "vitest-c", { barcode: null, description: "LECHE VITEST LITRO" });
    importStagedBoletas({ stagedDir: staged });
    const after = db
      .prepare(`SELECT product_id, description FROM grocery_receipt_items WHERE receipt_id = ?`)
      .get(res[0]!.receipt_id) as { product_id: number | null; description: string };
    expect(after.description).toBe("LECHE VITEST LITRO");
    expect(after.product_id).toBeNull();
  });

  it("resolveAliasProductId prefers barcode over description", () => {
    db.prepare(`INSERT INTO grocery_products (name) VALUES ('vitest por-codigo')`).run();
    const byCode = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    db.prepare(`INSERT INTO grocery_products (name) VALUES ('vitest por-nombre')`).run();
    const byName = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    db.prepare(
      `INSERT INTO grocery_product_aliases (store_chain, barcode, product_id) VALUES ('vitest-chain', '111', ?)`
    ).run(byCode);
    db.prepare(
      `INSERT INTO grocery_product_aliases (store_chain, description, product_id) VALUES ('vitest-chain', 'X', ?)`
    ).run(byName);
    expect(resolveAliasProductId("vitest-chain", "111", "X")).toBe(byCode);
    expect(resolveAliasProductId("vitest-chain", null, "X")).toBe(byName);
    expect(resolveAliasProductId("vitest-chain", "999", "Y")).toBeNull();
  });
});

describe("grocery product config", () => {
  const cleanup: { table: string; id: number }[] = [];
  afterEach(() => {
    for (const c of cleanup.splice(0).reverse()) {
      db.prepare(`DELETE FROM ${c.table} WHERE id = ?`).run(c.id);
    }
  });

  function mkProduct(name: string, baseUnit = "un"): number {
    db.prepare(`INSERT INTO grocery_products (name, base_unit) VALUES (?, ?)`).run(name, baseUnit);
    const id = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    cleanup.push({ table: "grocery_products", id });
    return id;
  }
  function mkAlias(productId: number, barcode: string): number {
    db.prepare(
      `INSERT INTO grocery_product_aliases (store_chain, barcode, product_id) VALUES ('lider', ?, ?)`
    ).run(barcode, productId);
    const id = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    cleanup.push({ table: "grocery_product_aliases", id });
    return id;
  }

  it("content converts to canonical units and rejects dimension mismatches", () => {
    expect(canonicalContent(200, "g", "kg")).toBe(200);
    expect(canonicalContent(1.5, "kg", "g")).toBe(1500);
    expect(canonicalContent(0.2, "l", "ml")).toBe(200);
    expect(canonicalContent(180, "m", "m")).toBe(180);
    expect(() => canonicalContent(180, "m", "kg")).toThrow(/does not match/);
    expect(() => canonicalContent(1, "un", "un")).toThrow(/does not match/);
  });

  it("normalized price scales to the display base unit", () => {
    // 720 m of TP at $1x.xxx → $17/m; 200 ml milk at $500 → $2.500/L.
    expect(normalizedUnitPrice(12000, "m", 720)).toBe(17);
    expect(normalizedUnitPrice(500, "l", 200)).toBe(2500);
    expect(normalizedUnitPrice(500, "ml", 200)).toBe(3);
    expect(normalizedUnitPrice(500, "l", null)).toBeNull();
    expect(normalizedUnitPrice(990, "un", null)).toBe(990);
  });

  it("changing base-unit dimension clears alias contents; scale change keeps them", () => {
    const productId = mkProduct("vitest tp", "m");
    const aliasId = mkAlias(productId, "780vitest001");
    updateGroceryAliasConfig(aliasId, { content_value: 720, content_unit: "m" });
    let content = (db.prepare(`SELECT content FROM grocery_product_aliases WHERE id = ?`).get(aliasId) as { content: number }).content;
    expect(content).toBe(720);

    updateGroceryProductBaseUnit(productId, "kg"); // length → mass: meaningless, must clear
    content = (db.prepare(`SELECT content FROM grocery_product_aliases WHERE id = ?`).get(aliasId) as { content: number | null }).content!;
    expect(content).toBeNull();

    updateGroceryAliasConfig(aliasId, { content_value: 200, content_unit: "g" });
    updateGroceryProductBaseUnit(productId, "g"); // mass → mass: canonical content survives
    content = (db.prepare(`SELECT content FROM grocery_product_aliases WHERE id = ?`).get(aliasId) as { content: number }).content;
    expect(content).toBe(200);
  });

  it("merge re-points aliases, restamps all items, deletes the source", () => {
    // NOTE: alias identity is globally unique per (chain, barcode|description), so a source
    // alias can never collide with a target one — merge is a wholesale re-point.
    const target = mkProduct("vitest confort");
    const source = mkProduct("vitest confort 18x40");
    mkAlias(target, "780vitest-target");
    const movedSource = mkAlias(source, "780vitest-only");
    db.prepare(
      `INSERT INTO grocery_receipts (source, source_key, receipt_number, store_chain, branch, purchased_at, total_clp, payments_json)
       VALUES ('vitest', '<vitest-merge@x>', '9', 'lider', 'VITEST', '2037-02-01 10:00:00', 100, '[]')`
    ).run();
    const receiptId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    cleanup.push({ table: "grocery_receipts", id: receiptId });
    db.prepare(
      `INSERT INTO grocery_receipt_items (receipt_id, position, description, qty, qty_unit, unit_price_clp, total_clp, product_id, product_source)
       VALUES (?, 0, 'VITEST 18X40', '1', 'un', 100, 100, ?, 'manual')`
    ).run(receiptId, source);

    const res = mergeGroceryProducts(source, target);
    expect(res).toEqual({ aliases_moved: 1, items_restamped: 1 });
    expect(db.prepare(`SELECT 1 AS x FROM grocery_products WHERE id = ?`).get(source)).toBeUndefined();
    expect(
      (db.prepare(`SELECT product_id FROM grocery_product_aliases WHERE id = ?`).get(movedSource) as { product_id: number }).product_id
    ).toBe(target);
    const item = db
      .prepare(`SELECT product_id, product_source FROM grocery_receipt_items WHERE receipt_id = ?`)
      .get(receiptId) as { product_id: number; product_source: string };
    expect(item.product_id).toBe(target);
    expect(item.product_source).toBe("manual");
  });

  it("brands are a global catalog: pick-or-create, delete only when unused", () => {
    const productId = mkProduct("vitest leche g");
    const aliasId = mkAlias(productId, "780vitest-brand");
    const brandId = ensureGroceryBrand("Vitest Soprole");
    cleanup.push({ table: "grocery_brands", id: brandId });
    expect(ensureGroceryBrand("Vitest Soprole")).toBe(brandId);
    updateGroceryAliasConfig(aliasId, { brand_name: "Vitest Soprole" });
    expect(() => deleteGroceryBrand(brandId)).toThrow(/referenced/);
    updateGroceryAliasConfig(aliasId, { brand_id: null });
    deleteGroceryBrand(brandId);
    cleanup.pop();
  });
});
