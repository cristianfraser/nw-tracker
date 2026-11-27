/**
 * What a cartola month's rows are filed as and named, before and after the month is imported again
 * in place (a forced re-import or a fuller cartola restating rows whose printed text changed).
 *
 * A restated row keeps its id and flow, so what the user set on it (its own category, «Único»,
 * note, big group, pieces, links: keyed by the row's purchase key or flow) stays. What the row's
 * TEXT decides can move: the category a rule gives it (`expense_category_rules` keyed on
 * `vendorRuleKey` of the bank text), how its credit is classified, and the name it shows (the vendor
 * catalog, the transfer party the text prints). A snapshot reads them all through the pipelines the
 * pages read (`buildFlowsExpenseLines`, `buildFlowsCheckingIncomePayload`,
 * `checkingMovementShownName`), so the comparison is what a person would see; the carry
 * (`checkingRestatementCarry.ts`) keeps them, and the report script prints them.
 */
import type { Database } from "better-sqlite3";
import type { ShownName } from "nw-tracker-contracts/dto/flows";
import { transferCounterpartiesByMovementSide } from "./bankTransferNotices.js";
import { bankRowText } from "./bankRowFacts.js";
import { UNCLASSIFIED_CC_EXPENSE_SLUG } from "./ccExpenseCategories.js";
import { db } from "./db.js";
import { checkingMovementShownName, loadDisplayNameContext } from "./expenseDisplayNames.js";
import { buildFlowsExpenseLines } from "./flowsExpenses.js";
import { buildFlowsCheckingIncomePayload } from "./flowsCheckingInflows.js";

/** Where a category on an expense line comes from: the line's own («Único», a per-line row), a rule (or the pairing), none. */
export type CategorySource = "own" | "rule" | "none";

/** A line's category and its source; `purchase_key` is where its own category is filed (not compared). */
export type LineFiling = { slug: string; source: CategorySource; purchase_key: string };

/** One cartola row of the month as the pages show it. */
export type RestatedRowIdentity = {
  movement_id: number;
  bank_day: string;
  amount_clp: number;
  description: string;
  branch: string;
  document_no: string;
  /** Each expense line of the row (a gastos portion, a deposit-paired portion, a piece), by line key. */
  lines: Map<string, LineFiling>;
  /** A credit's classification: `income:<kind>`, `filtered:<reason>`, `excluded`, `refund:<slug>`; null for a debit or a credit no list holds. */
  credit: string | null;
  name: ShownName;
  /** The shown name is not the bank's text (the catalog, a counterparty or the cartola's transfer party named it). */
  named: boolean;
};

export type ExpenseIdentitySnapshot = {
  /** Every expense line of the ledger, by line key: a restatement must leave the others as they were. */
  lines: Map<string, LineFiling>;
  rows: Map<number, RestatedRowIdentity>;
};

/**
 * An expense line's key, stable across a restatement in place: its source and row, the portion of a
 * checking row (gastos or deposit-paired) or a card line's purchase key, its piece, role and cuota.
 * A checking row's purchase key names its position in the cartola, which a re-import may move.
 */
function lineKey(l: {
  source: string;
  statement_line_id: number;
  purchase_key: string;
  checking_purchase_portion?: string;
  piece_seq?: number;
  line_role: string;
  nro_cuota_current: number | null;
}): string {
  const portion = l.source === "checking" ? (l.checking_purchase_portion ?? "gastos") : l.purchase_key;
  return [l.source, l.statement_line_id, portion, l.piece_seq ?? "", l.line_role, l.nro_cuota_current ?? ""].join("|");
}

export function filingText(f: LineFiling | undefined): string {
  return f == null ? "—" : `${f.slug} (${f.source})`;
}

/** The ledger's expense lines and the months' cartola rows of the account, as the pages read them now. */
export function snapshotExpenseIdentity(accountId: number, periodMonths: readonly string[], dbHandle: Database = db): ExpenseIdentitySnapshot {
  const lines = new Map<string, LineFiling>();
  const byMovement = new Map<number, Map<string, LineFiling>>();
  for (const l of buildFlowsExpenseLines()) {
    let key = lineKey(l);
    for (let n = 2; lines.has(key); n++) key = `${lineKey(l)}#${n}`;
    const filing: LineFiling = {
      purchase_key: l.purchase_key,
      slug: l.category_slug,
      source: l.category_unique ? "own" : l.category_slug === UNCLASSIFIED_CC_EXPENSE_SLUG ? "none" : "rule",
    };
    lines.set(key, filing);
    if (l.source === "checking" && l.account_id === accountId) {
      const m = byMovement.get(l.statement_line_id) ?? new Map<string, LineFiling>();
      m.set(key, filing);
      byMovement.set(l.statement_line_id, m);
    }
  }
  const income = buildFlowsCheckingIncomePayload();
  const credit = new Map<number, string>();
  for (const l of income.lines) credit.set(l.movement_id, `income:${income.income_kind_by_movement_id[l.movement_id] ?? "unclassified"}`);
  for (const l of income.filtered_lines) credit.set(l.movement_id, `filtered:${l.filter_reason}`);
  for (const l of income.excluded_lines) credit.set(l.movement_id, "excluded");
  for (const l of income.refund_lines) credit.set(l.movement_id, `refund:${l.category_slug}`);

  const counterparties = transferCounterpartiesByMovementSide();
  const ctx = loadDisplayNameContext([]);
  const rows = new Map<number, RestatedRowIdentity>();
  for (const r of dbHandle
    .prepare(
      `SELECT m.id, e.stated_on AS bank_day, e.stated_amount AS amount FROM movements m
       JOIN flow_evidence e ON e.source_table = 'movements' AND e.source_row_id = m.id
       WHERE m.account_id = ? AND e.source_kind = 'cartola' AND e.stated_period IN (SELECT value FROM json_each(?))
       ORDER BY e.stated_period, e.stated_position`
    )
    .all(accountId, JSON.stringify(periodMonths)) as { id: number; bank_day: string; amount: number }[]) {
    const text = bankRowText(r.id);
    const shown = checkingMovementShownName(text.description, accountId, counterparties.get(`${r.id}|${accountId}`), ctx, `movement ${r.id}`);
    rows.set(r.id, {
      movement_id: r.id,
      bank_day: r.bank_day,
      amount_clp: r.amount,
      description: text.description,
      branch: text.branch ?? "",
      document_no: text.document_no ?? "",
      lines: byMovement.get(r.id) ?? new Map(),
      credit: credit.get(r.id) ?? null,
      name: shown.name,
      named: shown.name_detail != null,
    });
  }
  return { lines, rows };
}

/** A shown name as one line of text, for reports. */
export function shownNameLabel(name: ShownName): string {
  switch (name.kind) {
    case "text":
      return name.text;
    case "pays_card":
    case "paid_by_card":
      return `${name.kind} ${name.card_brand} ·${name.card_last4}`;
    case "paid_from_account":
      return `paid_from_account ${name.account_name}`;
    case "refund_of":
      return `refund of ${shownNameLabel(name.purchase)}`;
  }
}

/** One restated row whose printed text changed, before and after. */
export type RestatedRowChange = {
  movement_id: number;
  bank_day: string;
  amount_clp: number;
  /** The row's cells (branch · description · document) and its description alone. */
  text: { before: string; after: string };
  description: { before: string; after: string };
  /** Each of the row's expense lines with its category before and after (equal when kept). */
  lines: { key: string; before: LineFiling | undefined; after: LineFiling | undefined }[];
  credit: { before: string | null; after: string | null };
  name: { before: string; after: string; named_before: boolean; named_after: boolean };
};

export type RestatementDiff = {
  /** Rows of the month whose printed text (description, branch or document) changed. */
  changed: RestatedRowChange[];
  /** Rows of the month on file before and gone after, or new after (by id). */
  removed: number[];
  /**
   * Removed rows whose category (their own, or a rule's) no row of the month keeps: no row after of
   * their bank day and pesos shows it (a copy folded into the row it duplicates keeps it there).
   */
  removed_with_category: number[];
  added: number[];
  /** Expense lines of any row whose category changed (the restated rows' own included), or that came or went. */
  categories_changed: { key: string; before: LineFiling | undefined; after: LineFiling | undefined }[];
  /** Lines whose category stayed and only its source moved (a rule's category now the line's own): reported, not a change. */
  sources_moved: { key: string; before: LineFiling; after: LineFiling }[];
  /** Credits whose classification changed. */
  credits_changed: number[];
  /** Restated rows whose shown name changed and is now the bank's text (a name of their own lost). */
  names_lost: number[];
  /** Restated rows whose shown name changed to another name of their own. */
  names_changed: number[];
};

export function sameCategory(a: LineFiling | undefined, b: LineFiling | undefined): boolean {
  return a != null && b != null && a.slug === b.slug;
}

const rowText = (r: RestatedRowIdentity) => [r.branch, r.description, r.document_no].filter(Boolean).join(" · ");

export function diffExpenseIdentity(before: ExpenseIdentitySnapshot, after: ExpenseIdentitySnapshot): RestatementDiff {
  const diff: RestatementDiff = { changed: [], removed: [], removed_with_category: [], added: [], categories_changed: [], sources_moved: [], credits_changed: [], names_lost: [], names_changed: [] };
  for (const [id, b] of before.rows) {
    const a = after.rows.get(id);
    if (!a) {
      diff.removed.push(id);
      const kept = [...after.rows.values()].filter((r) => r.bank_day === b.bank_day && r.amount_clp === b.amount_clp);
      const lost = [...b.lines.values()].filter((l) => l.source !== "none" && !kept.some((r) => [...r.lines.values()].some((k) => k.slug === l.slug)));
      if (lost.length > 0) diff.removed_with_category.push(id);
      continue;
    }
    if (b.credit !== a.credit) diff.credits_changed.push(id);
    if (rowText(b) === rowText(a)) continue;
    const keys = [...new Set([...b.lines.keys(), ...a.lines.keys()])];
    const nameBefore = shownNameLabel(b.name);
    const nameAfter = shownNameLabel(a.name);
    diff.changed.push({
      movement_id: id,
      bank_day: a.bank_day,
      amount_clp: a.amount_clp,
      text: { before: rowText(b), after: rowText(a) },
      description: { before: b.description, after: a.description },
      lines: keys.map((key) => ({ key, before: b.lines.get(key), after: a.lines.get(key) })),
      credit: { before: b.credit, after: a.credit },
      name: { before: nameBefore, after: nameAfter, named_before: b.named, named_after: a.named },
    });
    // What a person sees is the name's text: a name that reads the same (the bank's text now as
    // clean as the name the catalog made of it) changed nothing.
    // A name of its own now the bank's text is lost; any other name that reads differently changed
    // (the bank's text before, a name now: the cleaner reading reaches the catalog). The bank's
    // text before and after is the text itself.
    if (nameBefore !== nameAfter) {
      if (b.named && !a.named) diff.names_lost.push(id);
      else if (a.named) diff.names_changed.push(id);
    }
  }
  for (const id of after.rows.keys()) if (!before.rows.has(id)) diff.added.push(id);
  // A removed row's lines go with it, a written row's come with it (counted as removed and added,
  // not as category changes).
  const removedLines = new Set(diff.removed.flatMap((id) => [...before.rows.get(id)!.lines.keys()]));
  const addedLines = new Set(diff.added.flatMap((id) => [...after.rows.get(id)!.lines.keys()]));
  for (const key of new Set([...before.lines.keys(), ...after.lines.keys()])) {
    if (removedLines.has(key) && !after.lines.has(key)) continue;
    if (addedLines.has(key) && !before.lines.has(key)) continue;
    const b = before.lines.get(key);
    const a = after.lines.get(key);
    if (!sameCategory(b, a)) diff.categories_changed.push({ key, before: b, after: a });
    else if (b!.source !== a!.source) diff.sources_moved.push({ key, before: b!, after: a! });
  }
  return diff;
}

/** The summary the re-import repair is gated on: categories changed and names lost must be 0. */
export function restatementSummaryLine(d: RestatementDiff): string {
  return (
    `rows changed: ${d.changed.length}; categories changed: ${d.categories_changed.length}; credits reclassified: ${d.credits_changed.length}; ` +
    `rows losing a shown name: ${d.names_lost.length}; shown names changed: ${d.names_changed.length}; category sources moved: ${d.sources_moved.length}; ` +
    `rows removed: ${d.removed.length} (with a category: ${d.removed_with_category.length}), added: ${d.added.length}`
  );
}

/** One block per changed row, for the report. */
export function describeRestatedRow(c: RestatedRowChange): string[] {
  const out = [`  movement ${c.movement_id} ${c.bank_day} ${c.amount_clp}`, `    text:  «${c.text.before}» → «${c.text.after}»`];
  for (const l of c.lines) {
    out.push(`    category: ${filingText(l.before)} → ${filingText(l.after)}${sameCategory(l.before, l.after) ? "" : "  CHANGED"}`);
  }
  if (c.credit.before != null || c.credit.after != null) {
    out.push(`    credit: ${c.credit.before ?? "—"} → ${c.credit.after ?? "—"}${c.credit.before === c.credit.after ? "" : "  CHANGED"}`);
  }
  const named = (n: boolean) => (n ? "own name" : "bank text");
  out.push(
    `    shown name: «${c.name.before}» (${named(c.name.named_before)}) → «${c.name.after}» (${named(c.name.named_after)})` +
      (c.name.before === c.name.after || !(c.name.named_before || c.name.named_after) ? "" : c.name.named_after ? "  CHANGED" : "  LOST")
  );
  return out;
}
