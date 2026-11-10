/**
 * A loan's lender, named: the loan's `lender_pattern` roles (`accountRoles.ts`) hold the words its
 * card statements name the lender by («HIPOTECARIA PACIFICO», «METLIFE»); the name shown for the
 * lender is the vendor catalog's display name for the first pattern the catalog knows, else the
 * first pattern spelled as a name. A loan with no lender role throws: nothing else names a lender.
 */
import { lenderMerchantPatternsOfLoan } from "./accountRoles.js";
import { titleCaseName } from "./expenseNameText.js";
import { loadVendorCatalog, type VendorCatalog } from "./vendorCatalog.js";

export function lenderDisplayName(loanAccountId: number, catalog: VendorCatalog = loadVendorCatalog()): string {
  const patterns = lenderMerchantPatternsOfLoan(loanAccountId).map((words) => words.join(" "));
  if (patterns.length === 0) throw new Error(`loan account ${loanAccountId} has no lender_pattern role: its lender has no name`);
  for (const pattern of patterns) {
    const listed = catalog.lookup(pattern);
    if (listed) return listed;
  }
  return titleCaseName(patterns[0]!);
}
