/** Grocery catalog (/flows/expenses/groceries): summary, classification, price history. */
import express from "express";
import {
  classifyGroceryGroups,
  GroceryAliasConflictError,
  groceryProductHistory,
  listGroceryProducts,
  listGroceryReceiptItems,
  listGroceryReceipts,
  listUnclassifiedGroups,
  type ClassifyTarget,
} from "../groceryProducts.js";

export function registerGroceriesRoutes(app: express.Express): void {
  app.get("/api/groceries/summary", (_req, res) => {
    res.json({
      unclassified: listUnclassifiedGroups(),
      products: listGroceryProducts(),
      receipts: listGroceryReceipts(),
    });
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
