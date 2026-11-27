/**
 * The seam between the cartola import and the restatement carry (`checkingRestatementCarry.ts`):
 * the carry reads the pages' pipelines, which reach back into the import, so the import asks for
 * it through this hook, which the carry registers when it loads (the server's statements apply,
 * the scripts and the test setup load it). A replaced month whose rows read in other text with no
 * carry registered throws: it is never imported without it.
 */
import type { Database } from "better-sqlite3";
import type { ParsedCheckingCartola } from "./checkingCartolaParse.js";

export type RestatementCarry = {
  /** Rows of the month whose printed text changed. */
  rows_changed: number;
  /** Text rules passed over to the new spelling (origin `cartola_spelling`): the row keeps its category through the rule. */
  rules_passed: { movement_id: number; vendor: string; link: string | null; category: string }[];
  /** Lines that keep their category as their own «Único»: no rule could carry it (a re-import repair is gated on this). */
  own_categories: { movement_id: number; purchase_key: string; category: string; source: string }[];
  /** New spellings the catalog now names as the old text was named (source `spelling`). */
  spellings_added: { movement_id: number; pattern: string; display: string }[];
  /** What the catalog change carried for those spellings (`describeVendorCatalogChange`). */
  catalog_change: string[];
  /** Credits of the whole ledger the new text reads into another class (reported, not changed). */
  credits_reclassified: { movement_id: number; on: string; before: string | null; after: string | null }[];
  /** Rows whose shown name changed to another name of their own (reported). */
  names_changed: { movement_id: number; before: string; after: string }[];
  /** Removed rows whose category no row of the month keeps (reported; filed work refuses in the plan). */
  removed_with_category: number[];
};

/** What the import needs: a snapshot of the month before the write, and the carry after it (inside its transaction). */
export type RestatementIdentityHook = {
  snapshot: (accountId: number, periodMonths: readonly string[]) => unknown;
  carry: (accountId: number, cartola: ParsedCheckingCartola, before: unknown, dbHandle: Database) => RestatementCarry;
};

let registered: RestatementIdentityHook | null = null;

export function registerRestatementIdentityHook(hook: RestatementIdentityHook): void {
  registered = hook;
}

export function restatementIdentityHook(): RestatementIdentityHook {
  if (!registered) {
    throw new Error("a cartola month read in other text needs the restatement carry: import ./checkingRestatementCarry.js where the import runs");
  }
  return registered;
}

/** Whether anything is worth a line in the import's report. */
export function restatementCarryIsEmpty(c: RestatementCarry): boolean {
  return (
    c.rows_changed === 0 &&
    c.rules_passed.length === 0 &&
    c.own_categories.length === 0 &&
    c.spellings_added.length === 0 &&
    c.credits_reclassified.length === 0 &&
    c.names_changed.length === 0 &&
    c.removed_with_category.length === 0
  );
}

/** The carry as lines a person reads (the import log, the report script). */
export function describeRestatementCarry(c: RestatementCarry): string[] {
  const out = [`  text changed on ${c.rows_changed} row(s)`];
  for (const r of c.rules_passed) out.push(`  rule passed to the new spelling: «${r.vendor}»${r.link ? ` (${r.link})` : ""} → ${r.category} (movement ${r.movement_id})`);
  for (const o of c.own_categories) out.push(`  KEPT AS ITS OWN: movement ${o.movement_id} → ${o.category} (was ${o.source}; no rule carries it)`);
  for (const s of c.spellings_added) out.push(`  catalog spelling added: «${s.pattern}» → «${s.display}» (movement ${s.movement_id})`);
  for (const l of c.catalog_change) out.push(`  catalog change:${l}`);
  for (const r of c.credits_reclassified) out.push(`  CREDIT RECLASSIFIED: movement ${r.movement_id} (${r.on}) ${r.before ?? "—"} → ${r.after ?? "—"}`);
  for (const n of c.names_changed) out.push(`  shown name now: movement ${n.movement_id} «${n.before}» → «${n.after}»`);
  for (const id of c.removed_with_category) out.push(`  REMOVED WITH ITS CATEGORY: movement ${id}`);
  return out;
}
