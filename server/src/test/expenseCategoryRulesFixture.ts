import { vendorRuleKey } from "../bankMerchantName.js";
import type { ExpenseCategoryRules } from "../expenseCategoryRules.js";
import { vendorCatalogFromEntries, type VendorCatalogEntry } from "../vendorCatalogMatch.js";

/** Global category rules for tests: general rules by merchant name, an optional catalog. */
export function rulesFor(
  general: readonly (readonly [merchant: string, slug: string])[],
  catalogEntries: readonly VendorCatalogEntry[] = []
): ExpenseCategoryRules {
  const catalog = vendorCatalogFromEntries(catalogEntries);
  return {
    catalog,
    general: new Map(general.map(([m, slug]) => [vendorRuleKey(m, catalog), slug])),
    specific: new Map(),
  };
}
