/**
 * Migration 252: the per-account merchant rules (`cc_expense_merchant_categories`, keyed on the
 * bank's merchant text per card or bank account) become global general rules keyed on the vendor
 * (`vendorRuleKey`: the vendor catalog's brand). Rules that land on one vendor with different
 * categories conflict; the category most rules carry wins (ties: the lowest category id), and
 * `server/scripts/report-expense-category-rule-migration.ts` lists every conflict before the
 * migration runs. Pure apart from the handle it is given (it runs while `db.ts` is loading).
 */
import type { Database as DatabaseType } from "better-sqlite3";
import { vendorRuleKey } from "./bankMerchantName.js";
import { vendorCatalogFromEntries, type VendorCatalogEntry } from "./vendorCatalogMatch.js";

export type MergedRule = {
  vendor: string;
  category_id: number;
  /** The old rules that landed on this vendor: merchant text, account, category. */
  sources: { merchant_key: string; account_id: number; category_id: number }[];
  /** More than one category among the sources. */
  conflict: boolean;
};

export function planExpenseCategoryRuleMigration(dbi: DatabaseType): MergedRule[] {
  const hasOld = dbi
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cc_expense_merchant_categories'`)
    .get();
  if (!hasOld) return [];
  const catalog = vendorCatalogFromEntries(
    dbi
      .prepare(`SELECT match_kind AS kind, pattern, display, source FROM vendor_catalog`)
      .all() as VendorCatalogEntry[]
  );
  const rows = dbi
    .prepare(`SELECT account_id, merchant_key, category_id FROM cc_expense_merchant_categories ORDER BY merchant_key, account_id`)
    .all() as { account_id: number; merchant_key: string; category_id: number }[];
  const byVendor = new Map<string, MergedRule["sources"]>();
  for (const r of rows) {
    const vendor = vendorRuleKey(r.merchant_key, catalog);
    if (!vendor) throw new Error(`merchant rule «${r.merchant_key}» (account ${r.account_id}) has no vendor key`);
    const list = byVendor.get(vendor) ?? [];
    list.push(r);
    byVendor.set(vendor, list);
  }
  return [...byVendor].map(([vendor, sources]) => {
    const counts = new Map<number, number>();
    for (const s of sources) counts.set(s.category_id, (counts.get(s.category_id) ?? 0) + 1);
    const [category_id] = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]!;
    return { vendor, category_id, sources, conflict: counts.size > 1 };
  });
}

export function runExpenseCategoryRuleMigration252(dbi: DatabaseType): void {
  const ins = dbi.prepare(`INSERT INTO expense_category_rules (vendor, category_id) VALUES (?, ?)`);
  for (const r of planExpenseCategoryRuleMigration(dbi)) ins.run(r.vendor, r.category_id);
  dbi.exec(`DROP TABLE IF EXISTS cc_expense_merchant_categories`);
}
