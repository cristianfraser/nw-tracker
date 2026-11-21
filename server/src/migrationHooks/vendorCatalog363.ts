/**
 * Migration 363's hook: the checking listing's «Giro Nacional VD» reads «Cajero automático», like
 * 248's «GIRO EN CAJERO AUTOMATICO», and Clínica Alemana's RUT names its cartola refunds
 * (`vendorCatalogChange.ts` carries the category rules).
 */
import type { Database as DatabaseType } from "better-sqlite3";
import { applyVendorCatalogChange, describeVendorCatalogChange } from "../vendorCatalogChange.js";
import { foldVendorName } from "../vendorCatalogMatch.js";
import { normalizeRut } from "nw-tracker-contracts";

export function runVendorCatalog363(dbi: DatabaseType): void {
  const report = applyVendorCatalogChange(dbi, {
    remove: [],
    upsert: [
      { kind: "prefix", pattern: foldVendorName("GIRO NACIONAL"), display: "Cajero automático", source: "seed" },
      { kind: "rut", pattern: normalizeRut("96.770.100-9"), display: "Clínica Alemana", source: "seed" },
    ],
  });
  const lines = describeVendorCatalogChange(report);
  if (lines.length > 0 && !process.env.VITEST) console.log(["[migration 363] vendor catalog:", ...lines].join("\n"));
}
