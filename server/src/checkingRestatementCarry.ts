/**
 * The carry rule of a cartola month imported again in place (`importCheckingCartola` with
 * `replaceMonth`: a forced re-import, a fuller cartola, the ledger rebuild) whose printed text
 * changed (the readers' shared reading, `cartolaText`): what the user saw on a row stays.
 *
 *  - A category the user set (the row's own: «Único», a per-line row) rides the row's purchase key
 *    and flow, which a restatement keeps: never touched.
 *  - A category a text rule gave the row (`expense_category_rules`, general or specific: see
 *    `CategorySource`) that the new text no longer reaches: the rule is passed over to the new
 *    spelling (`passCategoryRuleToSpelling`, origin `cartola_spelling`; a user's change of that
 *    rule makes it theirs), unless the new spelling's vendor has a rule of its own or the new rule
 *    would move another line's category — then, as for a category that came from structure the
 *    text also reads (the deposit pairing), the row keeps it as its own «Único» and the carry
 *    reports it (a report the re-import repair is gated on).
 *  - A shown name the vendor catalog gave the old text that the new text no longer reaches: the new
 *    spelling goes into the catalog through the catalog change path (`applyVendorCatalogChange`,
 *    which carries category rules), as an `exact` row of source `spelling` with the same display —
 *    consulted only when no other entry matches (`vendorCatalogMatch.ts`), never overwritten — and
 *    only when no other line of the ledger (card lines included) reads that text, so naming it
 *    renames nothing else. A name that came from elsewhere (a counterparty, the cartola's own
 *    transfer party) cannot be carried this way.
 *
 * After the carry the month is read once more; any category still changed (of any line of the
 * ledger) or shown name still lost refuses the cartola (`CartolaImportRefusal`
 * `restatement_identity`, every row named): nothing of it is written. Credits of the whole ledger
 * read into another class are reported, never changed back.
 *
 * Registers itself with the import (`checkingRestatementHook.ts`) when it loads.
 */
import type { Database } from "better-sqlite3";
import { cleanBankMerchant, splitProcessorPrefix, vendorRuleKey } from "./bankMerchantName.js";
import { getCcExpenseCategoryBySlug } from "./ccExpenseCategories.js";
import { CartolaImportRefusal } from "./checkingCartolaLedgerGuard.js";
import type { ParsedCheckingCartola } from "./checkingCartolaParse.js";
import {
  diffExpenseIdentity,
  filingText,
  snapshotExpenseIdentity,
  type ExpenseIdentitySnapshot,
  type RestatementDiff,
} from "./checkingRestatementIdentity.js";
import { registerRestatementIdentityHook, type RestatementCarry } from "./checkingRestatementHook.js";
import { db } from "./db.js";
import { passCategoryRuleToSpelling, TRANSFER_RULE_VENDOR } from "./expenseCategoryRules.js";
import { findLines } from "./cards/purchases.js";
import { putFlowCategory } from "./flows/flowCategories.js";
import { foldVendorName, loadVendorCatalog, type VendorCatalog } from "./vendorCatalog.js";
import { applyVendorCatalogChange, describeVendorCatalogChange } from "./vendorCatalogChange.js";

/** The catalog's name for a bank text. */
function catalogNameOf(raw: string, catalog: VendorCatalog): string | null {
  const cleaned = cleanBankMerchant(raw);
  const { name } = splitProcessorPrefix(cleaned);
  for (const key of [name, cleaned]) {
    const m = catalog.match(key);
    if (m) return m.display;
  }
  return null;
}

/** The folded names a bank text is looked up under (`catalogNameOf`'s keys). */
function catalogKeysOf(raw: string): string[] {
  const cleaned = cleanBankMerchant(raw);
  return [...new Set([foldVendorName(splitProcessorPrefix(cleaned).name), foldVendorName(cleaned)])].filter(Boolean);
}

/** Lines of the ledger other than `except` whose bank text is looked up under `pattern`: card merchants and bank-row descriptions. */
function otherTextsReading(pattern: string, except: ReadonlySet<number>, dbHandle: Database): string[] {
  const out: string[] = [];
  for (const merchant of new Set(findLines().map((l) => l.merchant))) {
    if (merchant && catalogKeysOf(merchant).includes(pattern)) out.push(`card line «${merchant}»`);
  }
  for (const r of dbHandle
    .prepare(`SELECT source_row_id AS id, stated_description AS text FROM flow_evidence WHERE source_table = 'movements' AND stated_description IS NOT NULL`)
    .all() as { id: number; text: string }[]) {
    if (!except.has(r.id) && catalogKeysOf(r.text).includes(pattern)) out.push(`movement ${r.id} «${r.text}»`);
  }
  return out;
}

class UndoRulePass extends Error {}

/**
 * Carries the month's categories and shown names across the restatement just written (inside its
 * transaction), from `before` (`snapshotExpenseIdentity` taken before the write). Throws
 * `CartolaImportRefusal` when something the user saw would still change.
 */
export function carryRestatementIdentity(
  accountId: number,
  cartola: ParsedCheckingCartola,
  before: ExpenseIdentitySnapshot,
  dbHandle: Database = db
): RestatementCarry {
  if (dbHandle !== db) throw new Error("the restatement carry reads the pages' pipelines, which read the app's database");
  const month = [cartola.period_month];
  const read = () => diffExpenseIdentity(before, snapshotExpenseIdentity(accountId, month));
  let diff = read();
  const carry: RestatementCarry = {
    rows_changed: diff.changed.length,
    rules_passed: [],
    own_categories: [],
    spellings_added: [],
    catalog_change: [],
    credits_reclassified: [],
    names_changed: [],
    removed_with_category: [],
  };
  const problems: string[] = [];
  const restated = new Set(diff.changed.map((c) => c.movement_id));

  // 1. A name the catalog gave the old text: the new spelling is named alike.
  if (diff.names_lost.length > 0) {
    const catalog = loadVendorCatalog();
    for (const id of diff.names_lost) {
      const c = diff.changed.find((x) => x.movement_id === id)!;
      const display = catalogNameOf(c.description.before, catalog);
      // Only a name the catalog made: a counterparty's or the cartola's transfer party is not the catalog's.
      if (display == null || display !== c.name.before) continue;
      const pattern = catalogKeysOf(c.description.after)[0];
      if (!pattern) continue;
      const stored = dbHandle
        .prepare(`SELECT display FROM vendor_catalog WHERE match_kind = 'exact' AND pattern = ? AND source = 'spelling'`)
        .get(pattern) as { display: string } | undefined;
      if (stored) {
        if (stored.display !== display) problems.push(`movement ${id}: the spelling «${pattern}» already names «${stored.display}», not «${display}»`);
        continue;
      }
      const others = otherTextsReading(pattern, restated, dbHandle);
      if (others.length > 0) {
        problems.push(`movement ${id}: naming «${pattern}» «${display}» would rename ${others.length} other line(s) (${others.slice(0, 3).join("; ")})`);
        continue;
      }
      const report = applyVendorCatalogChange(dbHandle, { remove: [], upsert: [{ kind: "exact", pattern, display, source: "spelling" }] });
      carry.spellings_added.push({ movement_id: id, pattern, display });
      carry.catalog_change.push(...describeVendorCatalogChange(report));
    }
    if (carry.spellings_added.length > 0) diff = read();
  }

  // 2. A category a text rule gave a restated row: the rule follows the new spelling; else the row's own.
  const movementOfKey = (key: string) => (key.startsWith("checking|") ? Number(key.split("|")[1]) : null);
  const movedBefore = () => new Set(diff.categories_changed.map((c) => c.key));
  for (const c of [...diff.categories_changed]) {
    const movementId = movementOfKey(c.key);
    if (movementId == null || !restated.has(movementId) || c.before == null || c.after == null) continue;
    if (c.before.source === "own" || c.before.source === "none") continue;
    const category = getCcExpenseCategoryBySlug(c.before.slug);
    if (!category) throw new Error(`restatement carry: category ${c.before.slug} of movement ${movementId} is not a category`);
    if ((c.before.source === "rule" || c.before.source === "specific_rule") && c.after.merchant) {
      const link = c.before.source === "specific_rule" ? c.before.link : null;
      const vendor = link?.kind === "recipient" ? TRANSFER_RULE_VENDOR : vendorRuleKey(c.after.merchant, loadVendorCatalog());
      const others = movedBefore();
      let passed = false;
      try {
        dbHandle.transaction(() => {
          if (!passCategoryRuleToSpelling(vendor, link, category.id, dbHandle)) throw new UndoRulePass();
          const next = read();
          const line = next.categories_changed.find((x) => x.key === c.key);
          const newlyMoved = next.categories_changed.filter((x) => !others.has(x.key));
          // The rule must give this line its category back and move nothing else.
          if (line != null || newlyMoved.length > 0) throw new UndoRulePass();
          diff = next;
        })();
        passed = true;
      } catch (e) {
        if (!(e instanceof UndoRulePass)) throw e;
      }
      if (passed) {
        carry.rules_passed.push({ movement_id: movementId, vendor, link: link ? `${link.kind} ${link.key}` : null, category: c.before.slug });
        continue;
      }
    }
    putFlowCategory(accountId, c.after.purchase_key, category.id, "replace", dbHandle);
    carry.own_categories.push({ movement_id: movementId, purchase_key: c.after.purchase_key, category: c.before.slug, source: c.before.source });
    diff = read();
  }

  problems.push(
    ...diff.categories_changed.map((c) => `expense line ${c.key}: category ${filingText(c.before)} → ${filingText(c.after)}`),
    ...diff.names_lost.map((id) => {
      const c = diff.changed.find((x) => x.movement_id === id)!;
      return `movement ${id}: shown name «${c.name.before}» → the bank's text «${c.name.after}»`;
    })
  );
  if (problems.length > 0) {
    throw new CartolaImportRefusal(cartola.period_month, cartola.source_file, "restatement_identity", [
      ...problems,
      "the new text would change what these rows show; nothing of this cartola was written",
    ]);
  }
  return reported(carry, diff);
}

function reported(carry: RestatementCarry, diff: RestatementDiff): RestatementCarry {
  carry.credits_reclassified.push(...diff.credits_changed);
  for (const id of diff.names_changed) {
    const c = diff.changed.find((x) => x.movement_id === id)!;
    carry.names_changed.push({ movement_id: id, before: c.name.before, after: c.name.after });
  }
  carry.removed_with_category.push(...diff.removed_with_category);
  return carry;
}

registerRestatementIdentityHook({
  snapshot: (accountId, periodMonths) => snapshotExpenseIdentity(accountId, periodMonths),
  carry: (accountId, cartola, before, dbHandle) => carryRestatementIdentity(accountId, cartola, before as ExpenseIdentitySnapshot, dbHandle),
});
