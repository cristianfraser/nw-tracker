/** Grocery catalog (/flows/expenses/groceries): summary, classification, price history. */
import express from "express";
import {
  classifyGroceryGroups,
  deleteGroceryBrand,
  ensureGroceryBrand,
  GroceryAliasConflictError,
  groceryProductDetail,
  groceryProductHistory,
  isGroceryBaseUnit,
  listGroceryBrands,
  listGroceryProducts,
  listGroceryReceiptItems,
  listGroceryReceipts,
  listUnclassifiedGroups,
  mergeGroceryProducts,
  renameGroceryBrand,
  updateGroceryAliasConfig,
  updateGroceryProductBaseUnit,
  type ClassifyTarget,
  type GroceryBaseUnit,
} from "../groceryProducts.js";

function idParam(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function registerGroceriesRoutes(app: express.Express): void {
  app.get("/api/groceries/summary", (_req, res) => {
    res.json({
      unclassified: listUnclassifiedGroups(),
      products: listGroceryProducts(),
      receipts: listGroceryReceipts(),
    });
  });

  app.get("/api/groceries/products/:id", (req, res) => {
    const id = idParam(req.params.id);
    if (id == null) {
      res.status(400).json({ error: "invalid product id" });
      return;
    }
    res.json(groceryProductDetail(id));
  });

  app.patch("/api/groceries/products/:id", (req, res) => {
    const id = idParam(req.params.id);
    const baseUnit = (req.body as { base_unit?: unknown } | null)?.base_unit;
    if (id == null || !isGroceryBaseUnit(baseUnit)) {
      res.status(400).json({ error: "invalid product id or base_unit" });
      return;
    }
    updateGroceryProductBaseUnit(id, baseUnit);
    res.json(groceryProductDetail(id));
  });

  app.post("/api/groceries/products/:id/merge", (req, res) => {
    const id = idParam(req.params.id);
    const into = idParam(String((req.body as { into_product_id?: unknown } | null)?.into_product_id ?? ""));
    if (id == null || into == null) {
      res.status(400).json({ error: "invalid product ids" });
      return;
    }
    res.json(mergeGroceryProducts(id, into));
  });

  app.patch("/api/groceries/aliases/:id", (req, res) => {
    const id = idParam(req.params.id);
    if (id == null) {
      res.status(400).json({ error: "invalid alias id" });
      return;
    }
    const body = req.body as {
      brand_id?: number | null;
      brand_name?: string;
      content_value?: number | null;
      content_unit?: string;
    } | null;
    if (body?.content_value != null && !isGroceryBaseUnit(body.content_unit)) {
      res.status(400).json({ error: "content_unit required with content_value" });
      return;
    }
    updateGroceryAliasConfig(id, {
      brand_id: body?.brand_id,
      brand_name: body?.brand_name,
      content_value: body?.content_value,
      content_unit: body?.content_unit as GroceryBaseUnit | undefined,
    });
    res.json({ ok: true });
  });

  app.get("/api/groceries/brands", (_req, res) => {
    res.json({ brands: listGroceryBrands() });
  });

  app.post("/api/groceries/brands", (req, res) => {
    const name = String((req.body as { name?: unknown } | null)?.name ?? "").trim();
    if (!name) {
      res.status(400).json({ error: "name required" });
      return;
    }
    res.json({ id: ensureGroceryBrand(name), name });
  });

  app.patch("/api/groceries/brands/:id", (req, res) => {
    const id = idParam(req.params.id);
    const name = String((req.body as { name?: unknown } | null)?.name ?? "").trim();
    if (id == null || !name) {
      res.status(400).json({ error: "invalid id or name" });
      return;
    }
    renameGroceryBrand(id, name);
    res.json({ ok: true });
  });

  app.delete("/api/groceries/brands/:id", (req, res) => {
    const id = idParam(req.params.id);
    if (id == null) {
      res.status(400).json({ error: "invalid brand id" });
      return;
    }
    deleteGroceryBrand(id);
    res.json({ ok: true });
  });

  app.get("/api/groceries/products/:id/history", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "invalid product id" });
      return;
    }
    res.json({ rows: groceryProductHistory(id) });
  });

  app.get("/api/groceries/receipts/:id/items", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "invalid receipt id" });
      return;
    }
    res.json({ items: listGroceryReceiptItems(id) });
  });

  app.post("/api/groceries/classify", (req, res) => {
    const body = req.body as {
      store_chain?: unknown;
      targets?: unknown;
      product_id?: unknown;
      new_product_name?: unknown;
    } | null;
    const chain = String(body?.store_chain ?? "").trim();
    const rawTargets = Array.isArray(body?.targets) ? body!.targets : [];
    const targets: ClassifyTarget[] = [];
    for (const t of rawTargets) {
      const barcode = (t as { barcode?: unknown })?.barcode;
      const description = (t as { description?: unknown })?.description;
      targets.push({
        barcode: barcode == null ? null : String(barcode),
        description: String(description ?? ""),
      });
    }
    if (!chain || targets.length === 0) {
      res.status(400).json({ error: "store_chain and targets are required" });
      return;
    }
    const productId = body?.product_id == null ? undefined : Number(body.product_id);
    try {
      res.json(
        classifyGroceryGroups({
          store_chain: chain,
          targets,
          product_id: productId,
          new_product_name: body?.new_product_name == null ? undefined : String(body.new_product_name),
        })
      );
    } catch (e) {
      if (e instanceof GroceryAliasConflictError) {
        res.status(409).json({ error: e.message });
        return;
      }
      throw e;
    }
  });
}
