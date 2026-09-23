import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  groceryReceiptKey,
  hasPendingGroceryReceipts,
  importStagedGroceryReceipts,
  listStagedReceipts,
  movementIsTerminal,
  resolveAliasProductId,
  type StagingRoot,
} from "./groceryReceiptsImport.js";
import {
  canonicalContent,
  groceryProductHistory,
  deleteGroceryBrand,
  ensureGroceryBrand,
  mergeGroceryProducts,
  normalizedUnitPrice,
  updateGroceryAliasConfig,
  updateGroceryProductBaseUnit,
} from "./groceryProducts.js";

/**
 * Receipt/items/classification/identity behavior, movement-free: synthetic receipts paid
 * EFECTIVO (or on a chain without a card rule) skip the card-movement branch entirely, so no CC
 * master fixture is needed. Movement gating itself is exercised by the real pipeline
 * (closed-month/paid gates are thin date/amount guards).
 */

type ParsedOpts = {
  description?: string;
  barcode?: string | null;
  chain?: string;
  boletaNumber?: string;
  payments?: { method: string; amount_clp: number }[];
};

function syntheticParsed(key: string, opts?: ParsedOpts) {
  return {
    ...(opts?.chain ? { chain: opts.chain } : {}),
    boleta_number: opts?.boletaNumber ?? `9${key.replace(/\D/g, "")}01`,
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
    payments: opts?.payments ?? [{ method: "efectivo", amount_clp: 2500 }],
    total_printed_clp: 2500,
    articles_declared: 2,
    mi_club_points: null,
    parser_version: 1,
  };
}

/** lider_email root: Boleta.pdf + the e-mail's meta (message id) + parsed.json, as the fetcher and parser leave them. */
function syntheticEmailStaged(root: string, key: string, opts?: ParsedOpts) {
  const d = path.join(root, key);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "Boleta.pdf"), "");
  fs.writeFileSync(
    path.join(d, "meta.json"),
    JSON.stringify({ message_id: `<${key}@vitest>`, subject: "Boleta Digital Lider", date: "2037-01-05T00:22:00Z", body_text: "" })
  );
  fs.writeFileSync(path.join(d, "parsed.json"), JSON.stringify(syntheticParsed(key, opts)));
}

/** generic root: explicit {source, source_key} meta + parsed.json carrying the parser's chain. */
function syntheticPhotoStaged(
  root: string,
  key: string,
  opts?: ParsedOpts & { sourceKey?: string; source?: string; omitChain?: boolean }
) {
  const d = path.join(root, key);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, "meta.json"),
    JSON.stringify({
      source: opts?.source ?? "photo",
      source_key: opts?.sourceKey ?? `vitest-photo-${key}`,
      original_file: "receipt.heic",
      ingested_at: "2037-01-05T00:22:00Z",
    })
  );
  const parsed = syntheticParsed(key, { chain: opts?.omitChain ? undefined : (opts?.chain ?? "lider"), ...opts });
  fs.writeFileSync(path.join(d, "parsed.json"), JSON.stringify(parsed));
}

describe("groceryReceiptsImport", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    db.prepare(
      `DELETE FROM grocery_receipt_items WHERE receipt_id IN (
         SELECT id FROM grocery_receipts WHERE source_key LIKE '<vitest-%' OR source_key LIKE 'vitest-photo-%')`
    ).run();
    db.prepare(`DELETE FROM grocery_receipts WHERE source_key LIKE '<vitest-%' OR source_key LIKE 'vitest-photo-%'`).run();
    db.prepare(`DELETE FROM grocery_product_aliases WHERE store_chain = 'vitest-chain' OR description LIKE 'LECHE VITEST%' OR barcode = '7801234567890'`).run();
    db.prepare(`DELETE FROM grocery_products WHERE name LIKE 'vitest %'`).run();
  });

  function tmpRoot(kind: StagingRoot["kind"]): StagingRoot {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `vitest-receipts-${kind}-`));
    tmpDirs.push(d);
    return { kind, dir: d };
  }

  function receiptRow(id: number) {
    return db
      .prepare(`SELECT receipt_key, source, source_key, store_chain, card_paid_clp FROM grocery_receipts WHERE id = ?`)
      .get(id) as { receipt_key: string; source: string; source_key: string; store_chain: string; card_paid_clp: number };
  }

  it("imports an e-mail receipt with items, idempotently, under its natural key", () => {
    const email = tmpRoot("lider_email");
    syntheticEmailStaged(email.dir, "vitest-a");
    const first = importStagedGroceryReceipts({ roots: [email] });
    expect(first).toHaveLength(1);
    expect(first[0]!.receipt_status).toBe("inserted");
    expect(first[0]!.source).toBe("lider_email");
    expect(first[0]!.movement.status).toBe("not_card_paid");
    expect(first[0]!.items).toBe(1);
    expect(first[0]!.receipt_key).toBe(groceryReceiptKey("lider", "901", "2037-01-04 20:11:22"));
    expect(receiptRow(first[0]!.receipt_id)).toMatchObject({
      receipt_key: "lider|901|2037-01-04",
      source: "lider_email",
      source_key: "<vitest-a@vitest>",
    });

    // Stamped: a re-run touches nothing; --full re-upserts.
    const again = importStagedGroceryReceipts({ roots: [email] });
    expect(again[0]!.receipt_id).toBe(first[0]!.receipt_id);
    expect(again[0]!.receipt_status).toBe("unchanged");
    expect(again[0]!.items_classified).toBe(0);
    expect(fs.existsSync(path.join(email.dir, "vitest-a", "imported.json"))).toBe(true);
    expect(hasPendingGroceryReceipts([email])).toBe(false);
    const full = importStagedGroceryReceipts({ roots: [email], full: true });
    expect(full[0]!.receipt_status).toBe("updated");
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

  it("a photo of a paper receipt imports from the generic root with photo provenance", () => {
    const photos = tmpRoot("generic");
    syntheticPhotoStaged(photos.dir, "vitest-p1");
    const res = importStagedGroceryReceipts({ roots: [photos] });
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ root: "generic", source: "photo", chain: "lider", receipt_status: "inserted" });
    expect(res[0]!.movement.status).toBe("not_card_paid");
    expect(receiptRow(res[0]!.receipt_id)).toMatchObject({
      receipt_key: "lider|9101|2037-01-04",
      source: "photo",
      source_key: "vitest-photo-vitest-p1",
      store_chain: "lider",
    });
  });

  it("e-mail outranks photo: the e-mail takes the row over, a later photo is skipped", () => {
    const email = tmpRoot("lider_email");
    const photos = tmpRoot("generic");
    const boletaNumber = "000123456789";
    syntheticPhotoStaged(photos.dir, "vitest-twin", { boletaNumber });
    const fromPhoto = importStagedGroceryReceipts({ roots: [photos] });
    expect(fromPhoto[0]!.receipt_status).toBe("inserted");
    const id = fromPhoto[0]!.receipt_id;

    syntheticEmailStaged(email.dir, "vitest-twin-mail", { boletaNumber });
    const fromEmail = importStagedGroceryReceipts({ roots: [email] });
    expect(fromEmail[0]).toMatchObject({ receipt_id: id, receipt_status: "replaced", other_source: "photo" });
    expect(receiptRow(id)).toMatchObject({
      receipt_key: `lider|${boletaNumber}|2037-01-04`,
      source: "lider_email",
      source_key: "<vitest-twin-mail@vitest>",
    });
    const items = db.prepare(`SELECT COUNT(*) AS c FROM grocery_receipt_items WHERE receipt_id = ?`).get(id) as { c: number };
    expect(items.c).toBe(1);

    // The photo re-imports (it stays staged forever): its stamp said "owner", it no longer is,
    // so it re-runs once — reported as skipped, never written — and the e-mail is stamped.
    const photoAgain = importStagedGroceryReceipts({ roots: [photos, email] });
    const photoRes = photoAgain.find((r) => r.source === "photo")!;
    expect(photoRes).toMatchObject({ receipt_id: id, receipt_status: "skipped_duplicate", other_source: "lider_email" });
    expect(photoRes.movement.status).toBe("not_attempted");
    expect(receiptRow(id).source_key).toBe("<vitest-twin-mail@vitest>");
    expect(photoAgain.find((r) => r.source === "lider_email")!.receipt_status).toBe("unchanged");
    // Third run: both stamped, nothing to do.
    expect(importStagedGroceryReceipts({ roots: [photos, email] }).map((r) => r.receipt_status)).toEqual(["unchanged", "unchanged"]);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM grocery_receipts WHERE receipt_key = ?`).get(`lider|${boletaNumber}|2037-01-04`) as { c: number }).c).toBe(1);
  });

  it("two photos of one receipt: the first writer keeps the row, the second is skipped", () => {
    const photos = tmpRoot("generic");
    const boletaNumber = "000987654321";
    syntheticPhotoStaged(photos.dir, "vitest-shot-1", { boletaNumber, sourceKey: "vitest-photo-sha-1" });
    syntheticPhotoStaged(photos.dir, "vitest-shot-2", { boletaNumber, sourceKey: "vitest-photo-sha-2" });
    const res = importStagedGroceryReceipts({ roots: [photos] });
    expect(res.map((r) => r.receipt_status)).toEqual(["inserted", "skipped_duplicate"]);
    expect(res[1]!.other_source).toBe("photo");
    expect(receiptRow(res[0]!.receipt_id).source_key).toBe("vitest-photo-sha-1");
    // Re-running is stable: the same document keeps the row (no ping-pong between the two keys).
    const again = importStagedGroceryReceipts({ roots: [photos], full: true });
    expect(again.map((r) => r.receipt_status)).toEqual(["updated", "skipped_duplicate"]);
    expect(importStagedGroceryReceipts({ roots: [photos] }).map((r) => r.receipt_status)).toEqual(["unchanged", "unchanged"]);
  });

  it("a chain without a card rule stores items only, whatever card paid", () => {
    const photos = tmpRoot("generic");
    syntheticPhotoStaged(photos.dir, "vitest-jumbo", {
      chain: "vitest-chain",
      payments: [{ method: "tarjeta_otra", amount_clp: 2500 }],
    });
    const res = importStagedGroceryReceipts({ roots: [photos] });
    expect(res[0]!.movement.status).toBe("chain_items_only");
    expect(res[0]!.card_paid_clp).toBe(0);
    expect(receiptRow(res[0]!.receipt_id)).toMatchObject({ store_chain: "vitest-chain", card_paid_clp: 0 });
    expect(res[0]!.receipt_key.startsWith("vitest-chain|")).toBe(true);
  });

  it("the generic root fails fast on an unknown source or a chain-less parse", () => {
    const badSource = tmpRoot("generic");
    syntheticPhotoStaged(badSource.dir, "vitest-bad-src", { source: "scan" });
    expect(() => listStagedReceipts([badSource])).toThrow(/source must be one of/);

    const noChain = tmpRoot("generic");
    syntheticPhotoStaged(noChain.dir, "vitest-no-chain", { omitChain: true });
    expect(() => listStagedReceipts([noChain])).toThrow(/without chain/);
  });

  it("hasPendingGroceryReceipts: a document without a parse or without a current stamp is pending", () => {
    const email = tmpRoot("lider_email");
    const photos = tmpRoot("generic");
    expect(hasPendingGroceryReceipts([email, photos])).toBe(false);
    syntheticPhotoStaged(photos.dir, "vitest-gate");
    expect(hasPendingGroceryReceipts([email, photos])).toBe(true);
    expect(hasPendingGroceryReceipts([email])).toBe(false);
    importStagedGroceryReceipts({ roots: [photos] });
    expect(hasPendingGroceryReceipts([photos])).toBe(false);
    // A parse that changed under a stamp is pending again.
    fs.rmSync(path.join(photos.dir, "vitest-gate", "parsed.json"));
    syntheticPhotoStaged(photos.dir, "vitest-gate", { description: "LECHE VITEST NUEVA" });
    expect(hasPendingGroceryReceipts([photos])).toBe(true);
    // A staged document with no parse yet (the parser has not run) is pending.
    const d = path.join(email.dir, "vitest-gate-mail");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "Boleta.pdf"), "");
    expect(hasPendingGroceryReceipts([email])).toBe(true);
  });

  it("only terminal movement outcomes are stamped", () => {
    expect(movementIsTerminal("pending_branch")).toBe(false);
    expect(movementIsTerminal("matched")).toBe(true);
    for (const s of ["created", "duplicate", "same_day_amount", "closed_month", "not_card_paid", "chain_items_only", "not_attempted"] as const) {
      expect(movementIsTerminal(s)).toBe(true);
    }
  });

  it("classifies via barcode alias first, and re-import preserves the stamp", () => {
    db.prepare(`INSERT INTO grocery_products (name) VALUES ('vitest leche')`).run();
    const productId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    db.prepare(
      `INSERT INTO grocery_product_aliases (store_chain, barcode, product_id) VALUES ('lider', '7801234567890', ?)`
    ).run(productId);

    const email = tmpRoot("lider_email");
    syntheticEmailStaged(email.dir, "vitest-b");
    const res = importStagedGroceryReceipts({ roots: [email] });
    expect(res[0]!.items_classified).toBe(1);
    const item = db
      .prepare(`SELECT product_id, product_source FROM grocery_receipt_items WHERE receipt_id = ?`)
      .get(res[0]!.receipt_id) as { product_id: number; product_source: string };
    expect(item.product_id).toBe(productId);
    expect(item.product_source).toBe("alias");

    // Alias later removed: the stamp survives a re-import (history is stamped, not derived).
    db.prepare(`DELETE FROM grocery_product_aliases WHERE product_id = ?`).run(productId);
    importStagedGroceryReceipts({ roots: [email], full: true });
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

    const email = tmpRoot("lider_email");
    syntheticEmailStaged(email.dir, "vitest-c", { barcode: null });
    const res = importStagedGroceryReceipts({ roots: [email] });
    expect(res[0]!.items_classified).toBe(1);

    // Parser fix renames the line → the old stamp must not silently survive under new text.
    db.prepare(`DELETE FROM grocery_product_aliases WHERE product_id = ?`).run(productId);
    fs.rmSync(path.join(email.dir, "vitest-c"), { recursive: true });
    syntheticEmailStaged(email.dir, "vitest-c", { barcode: null, description: "LECHE VITEST LITRO" });
    importStagedGroceryReceipts({ roots: [email] });
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
    // 'un' is the count dimension: a multipack is N of the product.
    expect(canonicalContent(3, "un", "un")).toBe(3);
    expect(() => canonicalContent(180, "m", "kg")).toThrow(/does not match/);
    expect(() => canonicalContent(3, "un", "kg")).toThrow(/does not match/);
  });

  it("normalized price scales to the display base unit", () => {
    // 720 m of TP at $1x.xxx → $17/m; 200 ml milk at $500 → $2.500/L.
    expect(normalizedUnitPrice(12000, "m", 720)).toBe(17);
    expect(normalizedUnitPrice(500, "l", 200)).toBe(2500);
    expect(normalizedUnitPrice(500, "ml", 200)).toBe(3);
    expect(normalizedUnitPrice(500, "l", null)).toBeNull();
    // Count dimension: unconfigured = a package of 1; a x3 multipack divides.
    expect(normalizedUnitPrice(990, "un", null)).toBe(990);
    expect(normalizedUnitPrice(2490, "un", 3)).toBe(830);
  });

  it("count-dimension multipacks: per-unit price via content, x1-vs-x3 is heterogeneous", () => {
    const productId = mkProduct("vitest crackelet", "un");
    const singleAlias = mkAlias(productId, "780vitest-x1");
    const packAlias = mkAlias(productId, "780vitest-x3");
    updateGroceryAliasConfig(packAlias, { content_value: 3, content_unit: "un" });
    void singleAlias; // stays unconfigured: content defaults to 1
    db.prepare(
      `INSERT INTO grocery_receipts (receipt_key, source, source_key, receipt_number, store_chain, branch, purchased_at, total_clp, payments_json)
       VALUES ('lider|7|2037-04-01', 'vitest', '<vitest-pack@x>', '7', 'lider', 'VITEST', '2037-04-01 10:00:00', 3320, '[]')`
    ).run();
    const receiptId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    cleanup.push({ table: "grocery_receipts", id: receiptId });
    const insItem = db.prepare(
      `INSERT INTO grocery_receipt_items (receipt_id, position, barcode, description, qty, qty_unit, unit_price_clp, total_clp, product_id, product_source)
       VALUES (?, ?, ?, ?, '1', 'un', ?, ?, ?, 'manual')`
    );
    insItem.run(receiptId, 0, "780vitest-x1", "CRACKELET X1", 830, 830, productId);
    insItem.run(receiptId, 1, "780vitest-x3", "CRACKELET X3", 2490, 2490, productId);

    const history = groceryProductHistory(productId);
    expect(history.heterogeneous_packages).toBe(true);
    const byDesc = new Map(history.rows.map((r) => [r.description, r]));
    expect(byDesc.get("CRACKELET X1")!.normalized_unit_price_clp).toBe(830);
    expect(byDesc.get("CRACKELET X3")!.normalized_unit_price_clp).toBe(830);
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
      `INSERT INTO grocery_receipts (receipt_key, source, source_key, receipt_number, store_chain, branch, purchased_at, total_clp, payments_json)
       VALUES ('lider|9|2037-02-01', 'vitest', '<vitest-merge@x>', '9', 'lider', 'VITEST', '2037-02-01 10:00:00', 100, '[]')`
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

describe("weighed items price through the product config", () => {
  it("package modes show the paid amount; per-kg exists only when base_unit is mass", () => {
    db.prepare(`INSERT INTO grocery_products (name, base_unit) VALUES ('vitest pan', 'un')`).run();
    const productId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    db.prepare(
      `INSERT INTO grocery_receipts (receipt_key, source, source_key, receipt_number, store_chain, branch, purchased_at, total_clp, payments_json)
       VALUES ('lider|8|2037-03-01', 'vitest', '<vitest-kg@x>', '8', 'lider', 'VITEST', '2037-03-01 12:00:00', 347, '[]')`
    ).run();
    const receiptId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    // 0.116 kg at $2.991/kg → paid $347.
    db.prepare(
      `INSERT INTO grocery_receipt_items (receipt_id, position, barcode, description, qty, qty_unit, unit_price_clp, total_clp, product_id, product_source)
       VALUES (?, 0, '2038280000005', 'PAN HAM KG', '0.116', 'kg', 2991, 347, ?, 'manual')`
    ).run(receiptId, productId);
    try {
      // Unconfigured ('un'): only the paid price exists — no per-kg rate anywhere.
      let rows = groceryProductHistory(productId).rows;
      expect(rows[0]!.unit_price_clp).toBe(347);
      expect(rows[0]!.effective_unit_price_clp).toBe(347);
      expect(rows[0]!.normalized_unit_price_clp).toBeNull();

      // Configured as kg: the per-kg rate appears in the normalized layer, from the weight.
      updateGroceryProductBaseUnit(productId, "kg");
      const history = groceryProductHistory(productId);
      // Every weighed purchase is its own package size — per-package modes are meaningless.
      expect(history.heterogeneous_packages).toBe(true);
      rows = history.rows;
      expect(rows[0]!.effective_unit_price_clp).toBe(347);
      expect(rows[0]!.normalized_unit_price_clp).toBe(2991);

      updateGroceryProductBaseUnit(productId, "g");
      rows = groceryProductHistory(productId).rows;
      expect(rows[0]!.normalized_unit_price_clp).toBe(3);
    } finally {
      db.prepare(`DELETE FROM grocery_receipts WHERE id = ?`).run(receiptId);
      db.prepare(`DELETE FROM grocery_products WHERE id = ?`).run(productId);
    }
  });
});
