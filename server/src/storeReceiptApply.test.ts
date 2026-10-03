import { describe, expect, afterEach, it } from "vitest";
import { storeReceiptKind, type StoreReceiptPayload } from "nw-tracker-contracts";
import { db } from "./db.js";
import { VITEST_SANTANDER_CC_MASTER_NOTES } from "./test/vitestDbSeed.js";
import {
  applyStoreReceipt,
  groceryReceiptKey,
  incomingReceiptFromPayload,
  movementIsTerminal,
  resolveAliasProductId,
  resolveReceiptFacts,
} from "./storeReceiptApply.js";
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
 * EFECTIVO (or on a chain without a card rule) skip the card-line branch entirely, so no CC
 * master fixture is needed.
 */

type ReceiptOpts = {
  description?: string;
  barcode?: string | null;
  chain?: string;
  /** null: the photo lost it. */
  number?: string | null;
  purchasedAt?: string | null;
  payments?: { method: string; amount: number }[];
  document?: "email" | "pdf" | "photo";
  docKey?: string;
  photoTakenOn?: string;
  apply?: boolean;
};

/** A `store.receipt` as ingest sends it; `key` names the synthetic document. */
function receiptPayload(key: string, opts: ReceiptOpts = {}): StoreReceiptPayload {
  const document = opts.document ?? "email";
  return storeReceiptKind.payload.parse({
    apply: opts.apply ?? true,
    document: {
      kind: document,
      key: opts.docKey ?? (document === "email" ? `<${key}@vitest>` : `vitest-photo-${key}`),
      photo_taken_on: opts.photoTakenOn ?? null,
    },
    receipt: {
      chain: opts.chain ?? "lider",
      number: opts.number === undefined ? `9${key.replace(/\D/g, "")}01` : opts.number,
      branch: "CALLE FICTICIA #123",
      city: "COMUNA FICTICIA - SANTIAGO",
      purchased_at: opts.purchasedAt === undefined ? "2037-01-04 20:11:22" : opts.purchasedAt,
      purchase_date_source: opts.purchasedAt === null ? null : "printed",
      items: [
        {
          position: 0,
          barcode: opts.barcode === undefined ? "7801234567890" : opts.barcode,
          description: opts.description ?? "LECHE VITEST 1L",
          qty: "2",
          qty_unit: "un",
          unit_price: 1500,
          total: 3000,
          discount: 500,
          discount_labels: ["RF Lleve N x $"],
        },
      ],
      receipt_discounts: [],
      payments: opts.payments ?? [{ method: "efectivo", amount: 2500 }],
      loyalty_points: null,
    },
  });
}

describe("store.receipt apply", () => {
  afterEach(() => {
    db.prepare(
      `DELETE FROM grocery_receipt_items WHERE receipt_id IN (
         SELECT id FROM grocery_receipts WHERE source_key LIKE '<vitest-%' OR source_key LIKE 'vitest-photo-%')`
    ).run();
    db.prepare(`DELETE FROM grocery_receipts WHERE source_key LIKE '<vitest-%' OR source_key LIKE 'vitest-photo-%'`).run();
    db.prepare(`DELETE FROM grocery_product_aliases WHERE store_chain = 'vitest-chain' OR description LIKE 'LECHE VITEST%' OR barcode = '7801234567890'`).run();
    db.prepare(`DELETE FROM grocery_products WHERE name LIKE 'vitest %'`).run();
  });

  function receiptRow(id: number) {
    return db
      .prepare(`SELECT receipt_key, source, source_key, store_chain, card_paid_clp FROM grocery_receipts WHERE id = ?`)
      .get(id) as { receipt_key: string; source: string; source_key: string; store_chain: string; card_paid_clp: number };
  }

  it("imports an e-mailed receipt with items, idempotently, under its natural key", () => {
    const first = applyStoreReceipt(receiptPayload("vitest-a"));
    expect(first).toMatchObject({ receipt_status: "inserted", items: 1, final: true });
    expect(first.movement.status).toBe("not_card_paid");
    expect(first.receipt_key).toBe(groceryReceiptKey("lider", "901", "2037-01-04 20:11:22"));
    expect(receiptRow(first.receipt_id)).toMatchObject({
      receipt_key: "lider|901|2037-01-04",
      source: "email",
      source_key: "<vitest-a@vitest>",
    });
    const again = applyStoreReceipt(receiptPayload("vitest-a"));
    expect(again).toMatchObject({ receipt_id: first.receipt_id, receipt_status: "updated" });
    const rows = db.prepare(`SELECT COUNT(*) AS c FROM grocery_receipt_items WHERE receipt_id = ?`).get(first.receipt_id) as { c: number };
    expect(rows.c).toBe(1);
    const receipt = db
      .prepare(`SELECT branch, city, purchased_at, total_clp, discount_total_clp, card_paid_clp FROM grocery_receipts WHERE id = ?`)
      .get(first.receipt_id) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      branch: "CALLE FICTICIA #123",
      city: "COMUNA FICTICIA - SANTIAGO",
      purchased_at: "2037-01-04 20:11:22",
      total_clp: 2500,
      discount_total_clp: 500,
      card_paid_clp: 0,
    });
  });

  it("a dry run reports and writes nothing", () => {
    const res = applyStoreReceipt(receiptPayload("vitest-dry", { apply: false }));
    expect(res).toMatchObject({ receipt_status: "inserted", receipt_id: -1 });
    expect(db.prepare(`SELECT 1 FROM grocery_receipts WHERE source_key = '<vitest-dry@vitest>'`).get()).toBeUndefined();
  });

  it("a photo of a paper receipt imports with photo provenance", () => {
    const res = applyStoreReceipt(receiptPayload("vitest-p1", { document: "photo" }));
    expect(res).toMatchObject({ chain: "lider", receipt_status: "inserted" });
    expect(res.movement.status).toBe("not_card_paid");
    expect(receiptRow(res.receipt_id)).toMatchObject({
      receipt_key: "lider|9101|2037-01-04",
      source: "photo",
      source_key: "vitest-photo-vitest-p1",
      store_chain: "lider",
    });
  });

  it("e-mail outranks photo: the e-mail takes the row over, a later photo is skipped", () => {
    const number = "000123456789";
    const fromPhoto = applyStoreReceipt(receiptPayload("vitest-twin", { document: "photo", number }));
    expect(fromPhoto.receipt_status).toBe("inserted");
    const id = fromPhoto.receipt_id;

    const fromEmail = applyStoreReceipt(receiptPayload("vitest-twin-mail", { number }));
    expect(fromEmail).toMatchObject({ receipt_id: id, receipt_status: "replaced", other_document: "photo" });
    expect(receiptRow(id)).toMatchObject({
      receipt_key: `lider|${number}|2037-01-04`,
      source: "email",
      source_key: "<vitest-twin-mail@vitest>",
    });
    const items = db.prepare(`SELECT COUNT(*) AS c FROM grocery_receipt_items WHERE receipt_id = ?`).get(id) as { c: number };
    expect(items.c).toBe(1);

    const photoAgain = applyStoreReceipt(receiptPayload("vitest-twin", { document: "photo", number }));
    expect(photoAgain).toMatchObject({ receipt_id: id, receipt_status: "skipped_duplicate", other_document: "email", final: true });
    expect(photoAgain.movement.status).toBe("not_attempted");
    expect(receiptRow(id).source_key).toBe("<vitest-twin-mail@vitest>");
    expect((db.prepare(`SELECT COUNT(*) AS c FROM grocery_receipts WHERE receipt_key = ?`).get(`lider|${number}|2037-01-04`) as { c: number }).c).toBe(1);
  });

  it("two photos of one receipt: the first writer keeps the row, the second is skipped", () => {
    const number = "000987654321";
    const a = applyStoreReceipt(receiptPayload("vitest-shot-1", { document: "photo", number }));
    const b = applyStoreReceipt(receiptPayload("vitest-shot-2", { document: "photo", number }));
    expect([a.receipt_status, b.receipt_status]).toEqual(["inserted", "skipped_duplicate"]);
    expect(b.other_document).toBe("photo");
    // Stable: the same document keeps the row (no ping-pong between the two keys).
    expect(applyStoreReceipt(receiptPayload("vitest-shot-1", { document: "photo", number })).receipt_status).toBe("updated");
    expect(applyStoreReceipt(receiptPayload("vitest-shot-2", { document: "photo", number })).receipt_status).toBe("skipped_duplicate");
    expect(receiptRow(a.receipt_id).source_key).toBe("vitest-photo-vitest-shot-1");
  });

  it("a chain without a card rule stores items only, whatever card paid", () => {
    const res = applyStoreReceipt(
      receiptPayload("vitest-other", { document: "photo", chain: "vitest-chain", payments: [{ method: "tarjeta_otra", amount: 2500 }] })
    );
    expect(res.movement.status).toBe("chain_items_only");
    expect(res.card_paid).toBe(0);
    expect(receiptRow(res.receipt_id)).toMatchObject({ store_chain: "vitest-chain", card_paid_clp: 0 });
    expect(res.receipt_key.startsWith("vitest-chain|")).toBe(true);
  });

  it("the payload refuses a photo date on a document that is not a photo", () => {
    expect(() => receiptPayload("vitest-bad", { document: "email", photoTakenOn: "2037-01-05" })).toThrow(/only a photo/);
  });

  it("only final movement outcomes are stamped by the feeder", () => {
    expect(movementIsTerminal("pending_branch")).toBe(false);
    expect(movementIsTerminal("awaiting_card_line")).toBe(false);
    expect(movementIsTerminal("matched")).toBe(true);
    for (const s of ["created", "duplicate", "same_day_amount", "closed_month", "not_card_paid", "chain_items_only", "not_attempted"] as const) {
      expect(movementIsTerminal(s)).toBe(true);
    }
  });

  it("classifies via barcode alias first, and re-import preserves the stamp", () => {
    db.prepare(`INSERT INTO grocery_products (name) VALUES ('vitest leche')`).run();
    const productId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    db.prepare(`INSERT INTO grocery_product_aliases (store_chain, barcode, product_id) VALUES ('lider', '7801234567890', ?)`).run(productId);

    const res = applyStoreReceipt(receiptPayload("vitest-b"));
    expect(res.items_classified).toBe(1);
    const item = db
      .prepare(`SELECT product_id, product_source FROM grocery_receipt_items WHERE receipt_id = ?`)
      .get(res.receipt_id) as { product_id: number; product_source: string };
    expect(item).toEqual({ product_id: productId, product_source: "alias" });

    // Alias later removed: the stamp survives a re-import (history is stamped, not derived).
    db.prepare(`DELETE FROM grocery_product_aliases WHERE product_id = ?`).run(productId);
    applyStoreReceipt(receiptPayload("vitest-b"));
    const after = db.prepare(`SELECT product_id FROM grocery_receipt_items WHERE receipt_id = ?`).get(res.receipt_id) as { product_id: number };
    expect(after.product_id).toBe(productId);
  });

  it("a changed printed description sends the item back to unclassified on re-import", () => {
    db.prepare(`INSERT INTO grocery_products (name) VALUES ('vitest leche 2')`).run();
    const productId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    db.prepare(`INSERT INTO grocery_product_aliases (store_chain, description, product_id) VALUES ('lider', 'LECHE VITEST 1L', ?)`).run(productId);

    const res = applyStoreReceipt(receiptPayload("vitest-c", { barcode: null }));
    expect(res.items_classified).toBe(1);

    // Parser fix renames the line → the old stamp must not silently survive under new text.
    db.prepare(`DELETE FROM grocery_product_aliases WHERE product_id = ?`).run(productId);
    applyStoreReceipt(receiptPayload("vitest-c", { barcode: null, description: "LECHE VITEST LITRO" }));
    const after = db
      .prepare(`SELECT product_id, description FROM grocery_receipt_items WHERE receipt_id = ?`)
      .get(res.receipt_id) as { product_id: number | null; description: string };
    expect(after).toEqual({ product_id: null, description: "LECHE VITEST LITRO" });
  });

  it("resolveAliasProductId prefers barcode over description", () => {
    db.prepare(`INSERT INTO grocery_products (name) VALUES ('vitest por-codigo')`).run();
    const byCode = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    db.prepare(`INSERT INTO grocery_products (name) VALUES ('vitest por-nombre')`).run();
    const byName = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    db.prepare(`INSERT INTO grocery_product_aliases (store_chain, barcode, product_id) VALUES ('vitest-chain', '111', ?)`).run(byCode);
    db.prepare(`INSERT INTO grocery_product_aliases (store_chain, description, product_id) VALUES ('vitest-chain', 'X', ?)`).run(byName);
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

describe("receipts matched to an existing card line (Jumbo)", () => {
  const SRC = "vitest-grocery-jumbo-match";
  const PAID = 987_653;
  let accountId = 0;

  function cardLine(ddmmyyyy: string, merchant: string): void {
    accountId = (db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(VITEST_SANTANDER_CC_MASTER_NOTES) as { id: number }).id;
    const stmt = db
      .prepare(
        `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, card_last4, layout, currency)
         VALUES (?, 'santander', ?, '20/01/2037', '01/01/2037', '19/01/2037', '4242', 'compact', 'clp')`
      )
      .run(accountId, `${SRC}-${ddmmyyyy}-${merchant}`);
    db.prepare(
      `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp, installment_flag, parser_row_id)
       VALUES (?, ?, ?, ?, 0, ?)`
    ).run(Number(stmt.lastInsertRowid), ddmmyyyy, merchant, PAID, `${SRC}-${ddmmyyyy}`);
  }

  function jumbo(key: string, opts: ReceiptOpts = {}) {
    return incomingReceiptFromPayload(
      receiptPayload(key, { document: "photo", chain: "jumbo", payments: [{ method: "t_credito", amount: PAID }], ...opts })
    );
  }

  afterEach(() => {
    db.prepare(`DELETE FROM cc_statements WHERE source_pdf LIKE ?`).run(`${SRC}%`);
  });

  it("a dated receipt pairs with the chain's line of the same day and pesos", () => {
    cardLine("04/01/2037", "JUMBO FICTICIO");
    cardLine("04/01/2037", "OTRA TIENDA");
    const facts = resolveReceiptFacts(jumbo("vitest-j1"));
    expect(facts.card_line).toMatchObject({ status: "matched", account_id: accountId, line_date: "2037-01-04" });
    expect(facts.date_source).toBe("printed");
  });

  it("an undated photo takes its card line's date from the week up to the photo", () => {
    cardLine("02/01/2037", "CENCOSUD JUMBO");
    const facts = resolveReceiptFacts(jumbo("vitest-j2", { purchasedAt: null, photoTakenOn: "2037-01-05" }));
    expect(facts.date_source).toBe("card_line");
    expect(facts.staged.parsed.purchased_at).toBe("2037-01-02 00:00:00");
  });

  it("without a card line it keeps the photo's date; without either it throws", () => {
    cardLine("20/12/2036", "JUMBO FICTICIO"); // more than a week before the photo
    const facts = resolveReceiptFacts(jumbo("vitest-j3", { purchasedAt: null, photoTakenOn: "2037-01-05" }));
    expect(facts.card_line).toEqual({ status: "no_card_line" });
    expect(facts.staged.parsed.purchased_at).toBe("2037-01-05 00:00:00");
    expect(facts.date_source).toBe("photo");
    expect(() => resolveReceiptFacts(jumbo("vitest-j4", { purchasedAt: null }))).toThrow(/#! purchase_date/);
  });

  it("a receipt that lost its number is keyed on the photo", () => {
    const facts = resolveReceiptFacts(jumbo("vitest-j5", { number: null, docKey: "abcdef0123456789" }));
    expect(facts.staged.parsed.boleta_number).toBe("photo-abcdef012345");
  });
});
