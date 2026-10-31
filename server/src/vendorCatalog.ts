/**
 * The vendor catalog's database side (`vendor_catalog`): loading it and storing a picked branch.
 * Matching lives in `vendorCatalogMatch.ts` (pure), re-exported here.
 */
import { db } from "./db.js";
import { foldVendorName, vendorCatalogFromEntries, type VendorCatalog, type VendorCatalogEntry } from "./vendorCatalogMatch.js";

export * from "./vendorCatalogMatch.js";

/**
 * The user's pick for a cut branch («LIDER EXPRESS SANTI» → one of the places it could be): an
 * `exact` row with source `choice`, matched before seed rows. `key` is the folded name the row
 * showed; the pick must be one of the choices the catalog gives for it now.
 */
export function saveVendorBranchChoice(key: string, display: string): void {
  const pattern = foldVendorName(key);
  const choices = loadVendorCatalog().match(pattern)?.branchChoices ?? [];
  if (!choices.includes(display)) {
    throw new Error(`«${display}» is not a branch «${pattern}» can be (${choices.join(" | ") || "none"})`);
  }
  db.prepare(
    `INSERT INTO vendor_catalog (match_kind, pattern, display, source) VALUES ('exact', ?, ?, 'choice')
     ON CONFLICT (match_kind, pattern, source) DO UPDATE SET display = excluded.display`
  ).run(pattern, display);
}

export function loadVendorCatalog(): VendorCatalog {
  const rows = db
    .prepare(`SELECT match_kind AS kind, pattern, display, source FROM vendor_catalog`)
    .all() as VendorCatalogEntry[];
  return vendorCatalogFromEntries(rows);
}
