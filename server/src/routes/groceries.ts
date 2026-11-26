/** Grocery catalog (/flows/expenses/groceries): summary, classification, price history. */
import express from "express";
import {
  classifyGroceryGroups,
  deleteGroceryBrand,
  ensureGroceryBrand,
  GroceryAliasConflictError,
  groceryProductDetail,
  groceryProductHistory,
  listGroceryBrands,
  listGroceryProducts,
  listGroceryReceiptItems,
  listGroceryReceipts,
  listUnclassifiedGroups,
  mergeGroceryProducts,
  renameGroceryBrand,
  updateGroceryAliasConfig,
  updateGroceryProductBaseUnit,
} from "../groceryProducts.js";
import {
  groceryAliasPatchSchema,
  groceryBrandNameSchema,
  groceryClassifySchema,
  groceryProductMergeSchema,
  groceryProductPatchSchema,
} from "nw-tracker-contracts/requests/groceries";
import { writeHandler } from "../inputError.js";
import { parseBody } from "./shared.js";

function idParam(raw: unknown): number | null {
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

  app.patch("/api/groceries/products/:id", writeHandler((req, res) => {
    const id = idParam(req.params.id);
    if (id == null) {
      res.status(400).json({ error: "invalid product id or base_unit" });
      return;
    }
    updateGroceryProductBaseUnit(id, parseBody(groceryProductPatchSchema, req).base_unit);
    res.json(groceryProductDetail(id));
  }));

  app.post("/api/groceries/products/:id/merge", writeHandler((req, res) => {
    const id = idParam(req.params.id);
    if (id == null) {
      res.status(400).json({ error: "invalid product ids" });
      return;
    }
    res.json(mergeGroceryProducts(id, parseBody(groceryProductMergeSchema, req).into_product_id));
  }));

  app.patch("/api/groceries/aliases/:id", writeHandler((req, res) => {
    const id = idParam(req.params.id);
    if (id == null) {
      res.status(400).json({ error: "invalid alias id" });
      return;
    }
    updateGroceryAliasConfig(id, parseBody(groceryAliasPatchSchema, req));
    res.json({ ok: true });
  }));

  app.get("/api/groceries/brands", (_req, res) => {
    res.json({ brands: listGroceryBrands() });
  });

  app.post("/api/groceries/brands", writeHandler((req, res) => {
    const { name } = parseBody(groceryBrandNameSchema, req);
    res.json({ id: ensureGroceryBrand(name), name });
  }));

  app.patch("/api/groceries/brands/:id", writeHandler((req, res) => {
    const id = idParam(req.params.id);
    if (id == null) {
      res.status(400).json({ error: "invalid id or name" });
      return;
    }
    renameGroceryBrand(id, parseBody(groceryBrandNameSchema, req).name);
    res.json({ ok: true });
  }));

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
    res.json(groceryProductHistory(id));
  });

  app.get("/api/groceries/receipts/:id/items", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "invalid receipt id" });
      return;
    }
    res.json({ items: listGroceryReceiptItems(id) });
  });

  app.post("/api/groceries/classify", writeHandler((req, res) => {
    const body = parseBody(groceryClassifySchema, req);
    try {
      res.json(
        classifyGroceryGroups({
          store_chain: body.store_chain,
          targets: body.targets,
          product_id: body.product_id ?? undefined,
          new_product_name: body.new_product_name ?? undefined,
        })
      );
    } catch (e) {
      if (e instanceof GroceryAliasConflictError) {
        res.status(409).json({ error: e.message });
        return;
      }
      throw e;
    }
  }));
}
