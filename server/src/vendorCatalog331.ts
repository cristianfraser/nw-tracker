/**
 * Migration 331's hook: Australis' shops read «Cosecha del Mar» (`vendorCatalogChange.ts`).
 */
import type { Database as DatabaseType } from "better-sqlite3";
import { applyVendorCatalogChange, describeVendorCatalogChange } from "./vendorCatalogChange.js";
import { foldVendorName } from "./vendorCatalogMatch.js";

export function runVendorCatalog331(dbi: DatabaseType): void {
  const report = applyVendorCatalogChange(
    dbi,
    { remove: [], upsert: [{ kind: "prefix", pattern: foldVendorName("AUSTRALIS"), display: "Cosecha del Mar", source: "seed" }] },
    { exactBrand: "display" },
  );
  const lines = describeVendorCatalogChange(report);
  if (lines.length > 0 && !process.env.VITEST) console.log(["[migration 331] vendor catalog:", ...lines].join("\n"));
}
