/**
 * Expense category rules (`expense_category_rules`, migration 252), global — not per card or bank
 * account: the vendor decides the category wherever it was paid.
 *
 *   - a general rule: vendor → category (the vendor is `vendorRuleKey`: the vendor catalog's brand
 *     for the bank's merchant text, so every Jumbo branch shares one rule)
 *   - a specific rule: vendor + what the line is linked to → category; the link is a receipt's
 *     store (by brand), an App Store app, or a transfer's recipient (by RUT, else by name)
 *
 * Precedence on a line (`resolveCcExpenseCategory`, `withSpecificCategoryRules`): its own category
 * («Único», a per-line override) > a specific rule > the general rule > «sin categoría».
 */
import { db } from "./db.js";
import { vendorRuleKey, vendorRuleKeyCandidates } from "./bankMerchantName.js";
import { foldVendorName, loadVendorCatalog, type VendorCatalog } from "./vendorCatalog.js";

export type CategoryRuleLinkKind = "receipt" | "app" | "recipient";

export type CategoryRuleLink = { kind: CategoryRuleLinkKind; key: string };

export type ExpenseCategoryRules = {
  catalog: VendorCatalog;
  /** vendor → category slug. */
  general: Map<string, string>;
  /** `vendor|kind|key` → category slug. */
  specific: Map<string, string>;
};

function specificMapKey(vendor: string, link: CategoryRuleLink): string {
  return `${vendor}|${link.kind}|${link.key}`;
}

/**
 * A recipient rule is about the person, not the bank's wording of the transfer («Transf. Internet a
 * otro Bancos», «Transf a ANA PEREZ…»): every transfer shares this vendor.
 */
export const TRANSFER_RULE_VENDOR = "TRANSFERENCIA";

function specificVendorCandidates(rawMerchant: string, link: CategoryRuleLink, catalog: VendorCatalog): string[] {
  return link.kind === "recipient" ? [TRANSFER_RULE_VENDOR] : vendorRuleKeyCandidates(rawMerchant, catalog);
}

export function loadExpenseCategoryRules(): ExpenseCategoryRules {
  const rows = db
    .prepare(
      `SELECT r.vendor, r.link_kind, r.link_key, c.slug
       FROM expense_category_rules r JOIN cc_expense_categories c ON c.id = r.category_id`
    )
    .all() as { vendor: string; link_kind: string; link_key: string; slug: string }[];
  const general = new Map<string, string>();
  const specific = new Map<string, string>();
  for (const r of rows) {
    if (r.link_kind === "") general.set(r.vendor, r.slug);
    else specific.set(`${r.vendor}|${r.link_kind}|${r.link_key}`, r.slug);
  }
  return { catalog: loadVendorCatalog(), general, specific };
}

/** The general rule for a bank merchant: the first of its vendor keys with a rule. */
export function generalRuleCategory(rules: ExpenseCategoryRules, rawMerchant: string): string | null {
  for (const vendor of vendorRuleKeyCandidates(rawMerchant, rules.catalog)) {
    const slug = rules.general.get(vendor);
    if (slug) return slug;
  }
  return null;
}

/** The specific rule for a bank merchant and the line's link, or null. */
export function specificRuleCategory(
  rules: ExpenseCategoryRules,
  rawMerchant: string,
  link: CategoryRuleLink
): string | null {
  for (const vendor of specificVendorCandidates(rawMerchant, link, rules.catalog)) {
    const slug = rules.specific.get(specificMapKey(vendor, link));
    if (slug) return slug;
  }
  return null;
}

/** The link key for a receipt's store or an app: its brand, folded. */
export function linkKeyForName(name: string): string {
  return foldVendorName(name.replace(/\s*\+\d+$/, "").replace(/\s*\([^()]*\)\s*$/, ""));
}

function assertLink(link: CategoryRuleLink): void {
  if (!["receipt", "app", "recipient"].includes(link.kind) || !link.key.trim() || link.key.length > 200) {
    throw new Error(`invalid category rule link ${JSON.stringify(link)}`);
  }
}

/** Sets the rule a category change writes: the specific one when `link` is given, else the general one. */
export function setExpenseCategoryRule(rawMerchant: string, link: CategoryRuleLink | null, categoryId: number): void {
  if (link) assertLink(link);
  const vendor = link?.kind === "recipient" ? TRANSFER_RULE_VENDOR : vendorRuleKey(rawMerchant, loadVendorCatalog());
  if (!vendor) throw new Error(`no vendor for merchant «${rawMerchant}»`);
  db.prepare(
    `INSERT INTO expense_category_rules (vendor, link_kind, link_key, category_id) VALUES (?, ?, ?, ?)
     ON CONFLICT (vendor, link_kind, link_key) DO UPDATE SET category_id = excluded.category_id`
  ).run(vendor, link?.kind ?? "", link?.key ?? "", categoryId);
}

/**
 * Clears the rule a category change would write: the specific one when `link` is given, else every
 * general rule that reaches the merchant (its cut name's included).
 */
export function clearExpenseCategoryRule(rawMerchant: string, link: CategoryRuleLink | null): void {
  const catalog = loadVendorCatalog();
  if (link) {
    assertLink(link);
    db.prepare(`DELETE FROM expense_category_rules WHERE vendor = ? AND link_kind = ? AND link_key = ?`).run(
      link.kind === "recipient" ? TRANSFER_RULE_VENDOR : vendorRuleKey(rawMerchant, catalog),
      link.kind,
      link.key
    );
    return;
  }
  const del = db.prepare(`DELETE FROM expense_category_rules WHERE vendor = ? AND link_kind = ''`);
  for (const vendor of vendorRuleKeyCandidates(rawMerchant, catalog)) del.run(vendor);
}

/** Whether a general rule reaches the merchant. */
export function hasGeneralRule(rawMerchant: string): boolean {
  const sel = db.prepare(`SELECT 1 FROM expense_category_rules WHERE vendor = ? AND link_kind = ''`);
  return vendorRuleKeyCandidates(rawMerchant, loadVendorCatalog()).some((v) => sel.get(v) != null);
}

/** The category id of the first general rule that reaches the merchant, or null. */
export function generalRuleCategoryIdReaching(rawMerchant: string): number | null {
  const sel = db.prepare(`SELECT category_id FROM expense_category_rules WHERE vendor = ? AND link_kind = ''`);
  for (const vendor of vendorRuleKeyCandidates(rawMerchant, loadVendorCatalog())) {
    const row = sel.get(vendor) as { category_id: number } | undefined;
    if (row) return row.category_id;
  }
  return null;
}
