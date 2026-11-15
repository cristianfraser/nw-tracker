/**
 * Migration 335's hook: Saba's and Ikea's Parque Arauco stores under their Kennedy renderings (`vendorCatalogChange.ts`).
 */
import type { Database as DatabaseType } from "better-sqlite3";
import { applyVendorCatalogChange, describeVendorCatalogChange } from "./vendorCatalogChange.js";
import { foldVendorName } from "./vendorCatalogMatch.js";

export function runVendorCatalog335(dbi: DatabaseType): void {
  const report = applyVendorCatalogChange(dbi, {
    remove: [],
    upsert: [
      ...["SABA ARAUCO KEN", "SABA ARAUCO KENNEDY"].map((name) => ({ name, display: "Saba (Parque Arauco)" })),
      ...["IKEA OPEN KENNE", "IKEA OPEN KENNEDY"].map((name) => ({ name, display: "Ikea (Parque Arauco)" })),
    ].map(({ name, display }) => ({
      kind: "exact" as const,
      pattern: foldVendorName(name),
      display,
      source: "seed" as const,
    })),
  });
  const lines = describeVendorCatalogChange(report);
  if (lines.length > 0 && !process.env.VITEST) console.log(["[migration 335] vendor catalog:", ...lines].join("\n"));
}
