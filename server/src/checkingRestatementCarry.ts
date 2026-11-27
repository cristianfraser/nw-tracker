/**
 * The carry rule of a cartola month imported again in place whose printed text changed
 * (`importCheckingCartola` with `replaceMonth`; the readers' shared reading, `cartolaText`, made a
 * month read differently): what the user saw on a row stays.
 *
 *  - A category the user set (the row's own: «Único», a per-line row) is keyed by the row's purchase
 *    key and flow, which a restatement keeps: it is never touched.
 *  - A category a rule (or the pairing) gave the row is read again under the new text. When the new
 *    text no longer reaches it, the row keeps it as its own (its «Único» row, `putFlowCategory`) and
 *    the carry reports the row.
 *  - A shown name the vendor catalog gave the old text that the new text no longer reaches: the new
 *    spelling goes into the catalog as an `exact` row of source `spelling` with the same display
 *    (`vendor_catalog`, migration 384; the loader of the user's catalog file leaves it alone), and
 *    the carry reports it. A name that came from elsewhere (a counterparty, the cartola's own
 *    transfer party) cannot be carried this way.
 *
 * After the carry the month is read once more; any category still changed (of any line of the
 * ledger) or shown name still lost refuses the cartola (`CartolaImportRefusal`
 * `restatement_identity`, every row named): nothing of it is written. A credit read into another
 * class (income, filtered, refund) is reported, never changed back: the class is decided by the
 * text the bank printed, which the shared reading only reads truly.
 *
 * Registers itself with the import (`checkingRestatementHook.ts`) when it loads.
 */
import type { Database } from "better-sqlite3";
import { cleanBankMerchant, splitProcessorPrefix } from "./bankMerchantName.js";
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
import { db } from "./db.js";
import { registerRestatementIdentityHook, type RestatementCarry } from "./checkingRestatementHook.js";
import { putFlowCategory } from "./flows/flowCategories.js";
import { foldVendorName, loadVendorCatalog, type VendorCatalog } from "./vendorCatalog.js";

/** The catalog's name for a bank text, and the folded key it matched on. */
function catalogNameOf(raw: string, catalog: VendorCatalog): { key: string; display: string } | null {
  const cleaned = cleanBankMerchant(raw);
  const { name } = splitProcessorPrefix(cleaned);
  for (const key of [name, cleaned]) {
    const m = catalog.match(key);
    if (m) return { key: foldVendorName(key), display: m.display };
  }
  return null;
}

/** The folded name a bank text is looked up under first. */
function catalogKeyOf(raw: string): string {
  return foldVendorName(splitProcessorPrefix(cleanBankMerchant(raw)).name);
}

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
  let diff = diffExpenseIdentity(before, snapshotExpenseIdentity(accountId, month));
  const carry: RestatementCarry = { rows_changed: diff.changed.length, own_categories: [], spellings_added: [], credits_reclassified: [], names_changed: [] };
  if (diff.changed.length === 0 && diff.categories_changed.length === 0 && diff.names_lost.length === 0) return reported(carry, diff);

  // A name the catalog gave the old text: the new spelling is named alike.
  if (diff.names_lost.length > 0) {
    const catalog = loadVendorCatalog();
    const up = dbHandle.prepare(
      `INSERT INTO vendor_catalog (match_kind, pattern, display, source) VALUES ('exact', ?, ?, 'spelling')
       ON CONFLICT (match_kind, pattern, source) DO UPDATE SET display = excluded.display`
    );
    for (const id of diff.names_lost) {
      const c = diff.changed.find((x) => x.movement_id === id)!;
      const was = catalogNameOf(c.description.before, catalog);
      // Only a name the catalog made: a counterparty's or the cartola's transfer party is not the catalog's.
      if (was == null || was.display !== c.name.before) continue;
      const pattern = catalogKeyOf(c.description.after);
      if (!pattern) continue;
      up.run(pattern, was.display);
      carry.spellings_added.push({ movement_id: id, pattern, display: was.display });
    }
    if (carry.spellings_added.length > 0) diff = diffExpenseIdentity(before, snapshotExpenseIdentity(accountId, month));
  }

  // A category a rule gave a restated row, which the new text no longer reaches: the row's own.
  const restated = new Set(diff.changed.map((c) => c.movement_id));
  let wroteOwn = false;
  for (const c of diff.categories_changed) {
    const movementId = Number(c.key.split("|")[1]);
    if (!c.key.startsWith("checking|") || !restated.has(movementId) || c.before?.source !== "rule" || c.after == null) continue;
    const category = getCcExpenseCategoryBySlug(c.before.slug);
    if (!category) throw new Error(`restatement carry: category ${c.before.slug} of movement ${movementId} is not a category`);
    putFlowCategory(accountId, c.after.purchase_key, category.id, "replace", dbHandle);
    carry.own_categories.push({ movement_id: movementId, purchase_key: c.after.purchase_key, category: c.before.slug });
    wroteOwn = true;
  }
  if (wroteOwn) diff = diffExpenseIdentity(before, snapshotExpenseIdentity(accountId, month));

  const problems = [
    ...diff.categories_changed.map((c) => `expense line ${c.key}: category ${filingText(c.before)} → ${filingText(c.after)}`),
    ...diff.names_lost.map((id) => {
      const c = diff.changed.find((x) => x.movement_id === id)!;
      return `movement ${id}: shown name «${c.name.before}» → the bank's text «${c.name.after}» (no catalog name to carry)`;
    }),
  ];
  if (problems.length > 0) {
    throw new CartolaImportRefusal(cartola.period_month, cartola.source_file, "restatement_identity", [
      ...problems,
      "the new text would change what these rows show; nothing of this cartola was written",
    ]);
  }
  return reported(carry, diff);
}

function reported(carry: RestatementCarry, diff: RestatementDiff): RestatementCarry {
  for (const id of diff.credits_changed) {
    const c = diff.changed.find((x) => x.movement_id === id);
    carry.credits_reclassified.push({ movement_id: id, before: c?.credit.before ?? null, after: c?.credit.after ?? null });
  }
  for (const id of diff.names_changed) {
    const c = diff.changed.find((x) => x.movement_id === id)!;
    carry.names_changed.push({ movement_id: id, before: c.name.before, after: c.name.after });
  }
  return carry;
}

registerRestatementIdentityHook({
  snapshot: (accountId, periodMonths) => snapshotExpenseIdentity(accountId, periodMonths),
  carry: (accountId, cartola, before, dbHandle) => carryRestatementIdentity(accountId, cartola, before as ExpenseIdentitySnapshot, dbHandle),
});
