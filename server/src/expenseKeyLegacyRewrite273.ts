import type { Database as DatabaseType } from "better-sqlite3";
import { normalizeMerchantText } from "nw-tracker-contracts";

/**
 * Migration 273 hook: rewrites the stored purchase keys the runtime used to try as a second
 * lookup (`ccExpenseCategories` / `ccExpensePurchaseNotes` before the key module), so the runtime
 * reads one key per line and nothing else:
 *
 * - **Cartola rows keyed by movement id** (`checking-mv:<id>[:deposit]` on a movement whose note
 *   names its cartola): the categories and notes readers fell back to that key under the row's
 *   `checking-cartola:` key. «Único» rows and notes move to the cartola key.
 * - **Plan keys without a total** (`installment-h:` identity-only): the category reader fell back
 *   to it under every with-total key of the same identity. A row carrying a category is copied
 *   onto the with-total key of each plan of that identity, then dropped. A row with no category
 *   never took part in the fallback (only categories were looked up) and stays; so does a row whose
 *   identity has no plan, which is the key such lines still carry.
 *
 * Merging follows what the reader showed: a cartola / with-total row with a category wins; one with
 * none takes the legacy row's category. Notes: the target's notes win (the reader looked there
 * first). A key that resolves to nothing (its movement is gone) is counted and left — the hook does
 * not guess. Tables whose readers never fell back (big groups, deposit links, real-estate links)
 * are only counted (`*_unread`). The report goes to the boot log before anything is written.
 *
 * Frozen copies of the key spellings and of the cartola note grammar live here, so a later change
 * to the key module cannot change what this migration did.
 */

type Portion = "gastos" | "deposit";

function parseCheckingMv(key: string): { movementId: number; portion: Portion } | null {
  const m = /^checking-mv:(\d+)(:deposit)?$/.exec(key);
  return m ? { movementId: Number(m[1]), portion: m[2] ? "deposit" : "gastos" } : null;
}

function cartolaKeyFromNote(accountId: number, note: string | null, portion: Portion): string | null {
  const n = String(note ?? "").trim();
  if (!n.startsWith("import:cartola|")) return null;
  const periodMonth = n.split("|")[1]?.trim();
  const occurredOn = n.match(/\|on:([^|]+)/)?.[1]?.trim();
  const amountClp = n.match(/\|amt:([^|]+)/)?.[1]?.trim();
  const cartolaIndex = n.match(/\|idx:(\d+)/)?.[1]?.trim();
  if (!periodMonth || !occurredOn || amountClp == null || cartolaIndex == null) return null;
  const base = `checking-cartola:${accountId}:${periodMonth}:${occurredOn}:${amountClp}:${cartolaIndex}`;
  return portion === "deposit" ? `${base}:deposit` : base;
}

function parseInstallmentHWithoutTotal(
  key: string
): { accountId: number; purchaseIso: string; cuotas: number; merchantKey: string } | null {
  if (!key.startsWith("installment-h:")) return null;
  const parts = key.split(":");
  if (parts.length < 5) return null;
  if (parts.length >= 6 && /^\d+$/.test(parts[4] ?? "")) return null; // carries a total
  const accountId = Number(parts[1]);
  const cuotas = Number(parts[3]);
  const merchantKey = parts.slice(4).join(":");
  if (!Number.isFinite(accountId) || !parts[2] || !Number.isFinite(cuotas) || !merchantKey) return null;
  return { accountId, purchaseIso: parts[2]!, cuotas, merchantKey };
}

function installmentHWithTotal(
  id: { accountId: number; purchaseIso: string; cuotas: number; merchantKey: string },
  total: number
): string {
  return `installment-h:${id.accountId}:${id.purchaseIso}:${id.cuotas}:${total}:${id.merchantKey}`;
}

export type ExpenseKeyRewriteReport = {
  unique_cartola_moved: number;
  unique_cartola_merged: number;
  unique_cartola_shadowed: number;
  notes_cartola_moved: number;
  notes_cartola_shadowed: number;
  unique_plan_rewritten: number;
  unique_plan_targets: number;
  unique_plan_left_no_category: number;
  unique_plan_left_no_plan: number;
  movement_gone: Record<string, number>;
  not_cartola: Record<string, number>;
  cartola_unread: Record<string, number>;
  plan_without_total_unread: Record<string, number>;
};

type UniqueRow = { account_id: number; purchase_key: string; category_id: number | null };

export function runExpenseKeyLegacyRewrite273(dbi: DatabaseType): ExpenseKeyRewriteReport {
  const report: ExpenseKeyRewriteReport = {
    unique_cartola_moved: 0,
    unique_cartola_merged: 0,
    unique_cartola_shadowed: 0,
    notes_cartola_moved: 0,
    notes_cartola_shadowed: 0,
    unique_plan_rewritten: 0,
    unique_plan_targets: 0,
    unique_plan_left_no_category: 0,
    unique_plan_left_no_plan: 0,
    movement_gone: {},
    not_cartola: {},
    cartola_unread: {},
    plan_without_total_unread: {},
  };
  /** Writes, run only after the whole report is logged. Each legacy key maps to its own targets. */
  const writes: (() => void)[] = [];
  const movementNote = dbi.prepare(`SELECT account_id, note FROM movements WHERE id = ?`);
  const bump = (m: Record<string, number>, table: string) => {
    m[table] = (m[table] ?? 0) + 1;
  };

  /** Cartola key for a stored `checking-mv:` key, or null (gone / not a cartola row), counting why. */
  const cartolaTarget = (table: string, accountId: number, key: string): string | null => {
    const mv = parseCheckingMv(key);
    if (!mv) return null;
    const row = movementNote.get(mv.movementId) as { account_id: number; note: string | null } | undefined;
    if (!row) {
      bump(report.movement_gone, table);
      return null;
    }
    const target = row.account_id === accountId ? cartolaKeyFromNote(accountId, row.note, mv.portion) : null;
    if (!target) bump(report.not_cartola, table);
    return target;
  };

  // ── «Único» rows on cartola movements ───────────────────────────────────────────────────────
  const uniqueGet = dbi.prepare(
    `SELECT category_id FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`
  );
  const uniqueInsert = dbi.prepare(
    `INSERT INTO cc_expense_unique_purchases (account_id, purchase_key, category_id) VALUES (?, ?, ?)`
  );
  const uniqueSet = dbi.prepare(
    `UPDATE cc_expense_unique_purchases SET category_id = ? WHERE account_id = ? AND purchase_key = ?`
  );
  const uniqueDelete = dbi.prepare(
    `DELETE FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`
  );
  /** Plans putting a legacy row's category under `target` as the reader resolved it. */
  const planMergeUnique = (accountId: number, target: string, categoryId: number | null): "moved" | "merged" | "shadowed" => {
    const existing = uniqueGet.get(accountId, target) as { category_id: number | null } | undefined;
    if (!existing) {
      writes.push(() => uniqueInsert.run(accountId, target, categoryId));
      return "moved";
    }
    if (existing.category_id == null && categoryId != null) {
      writes.push(() => uniqueSet.run(categoryId, accountId, target));
      return "merged";
    }
    return "shadowed";
  };

  const uniqueMv = dbi
    .prepare(
      `SELECT account_id, purchase_key, category_id FROM cc_expense_unique_purchases
       WHERE purchase_key LIKE 'checking-mv:%' ORDER BY account_id, purchase_key`
    )
    .all() as UniqueRow[];
  for (const r of uniqueMv) {
    const target = cartolaTarget("cc_expense_unique_purchases", r.account_id, r.purchase_key);
    if (!target) continue;
    const outcome = planMergeUnique(r.account_id, target, r.category_id);
    writes.push(() => uniqueDelete.run(r.account_id, r.purchase_key));
    if (outcome === "moved") report.unique_cartola_moved += 1;
    else if (outcome === "merged") report.unique_cartola_merged += 1;
    else report.unique_cartola_shadowed += 1;
  }

  // ── Notes on cartola movements ──────────────────────────────────────────────────────────────
  const notesMv = dbi
    .prepare(
      `SELECT account_id, purchase_key FROM cc_expense_purchase_notes
       WHERE purchase_key LIKE 'checking-mv:%' ORDER BY account_id, purchase_key`
    )
    .all() as { account_id: number; purchase_key: string }[];
  const notesHas = dbi.prepare(`SELECT 1 FROM cc_expense_purchase_notes WHERE account_id = ? AND purchase_key = ?`);
  const notesMove = dbi.prepare(
    `UPDATE cc_expense_purchase_notes SET purchase_key = ? WHERE account_id = ? AND purchase_key = ?`
  );
  const notesDelete = dbi.prepare(`DELETE FROM cc_expense_purchase_notes WHERE account_id = ? AND purchase_key = ?`);
  for (const r of notesMv) {
    const target = cartolaTarget("cc_expense_purchase_notes", r.account_id, r.purchase_key);
    if (!target) continue;
    if (notesHas.get(r.account_id, target)) {
      writes.push(() => notesDelete.run(r.account_id, r.purchase_key));
      report.notes_cartola_shadowed += 1;
    } else {
      writes.push(() => notesMove.run(target, r.account_id, r.purchase_key));
      report.notes_cartola_moved += 1;
    }
  }

  // ── Plan keys without a total, in the categories ────────────────────────────────────────────
  const plansOfIdentity = dbi.prepare(
    `SELECT merchant, total_amount_clp FROM cc_installment_purchases
     WHERE account_id = ? AND date(purchase_date) = date(?) AND cuotas_totales = ?`
  );
  const uniquePlans = dbi
    .prepare(
      `SELECT account_id, purchase_key, category_id FROM cc_expense_unique_purchases
       WHERE purchase_key LIKE 'installment-h:%' ORDER BY account_id, purchase_key`
    )
    .all() as UniqueRow[];
  for (const r of uniquePlans) {
    const id = parseInstallmentHWithoutTotal(r.purchase_key);
    if (!id) continue;
    const totals = new Set(
      (plansOfIdentity.all(id.accountId, id.purchaseIso, id.cuotas) as { merchant: string | null; total_amount_clp: number }[])
        .filter((p) => normalizeMerchantText(p.merchant) === id.merchantKey && Number.isFinite(p.total_amount_clp))
        .map((p) => Math.round(p.total_amount_clp))
    );
    if (totals.size === 0) {
      report.unique_plan_left_no_plan += 1;
      continue;
    }
    if (r.category_id == null) {
      report.unique_plan_left_no_category += 1;
      continue;
    }
    for (const total of [...totals].sort((a, b) => a - b)) {
      planMergeUnique(r.account_id, installmentHWithTotal(id, total), r.category_id);
      report.unique_plan_targets += 1;
    }
    writes.push(() => uniqueDelete.run(r.account_id, r.purchase_key));
    report.unique_plan_rewritten += 1;
  }

  // ── Tables no reader fell back on: counted, never rewritten ─────────────────────────────────
  for (const table of ["cc_expense_purchase_notes", "cc_expense_purchase_big_groups", "expense_deposit_links", "real_estate_expense_links"]) {
    const keys = dbi
      .prepare(`SELECT purchase_key FROM ${table} WHERE purchase_key LIKE 'installment-h:%'`)
      .all() as { purchase_key: string }[];
    for (const { purchase_key } of keys) {
      if (parseInstallmentHWithoutTotal(purchase_key)) bump(report.plan_without_total_unread, table);
    }
  }
  for (const table of ["cc_expense_purchase_big_groups", "expense_deposit_links", "real_estate_expense_links", "real_estate_expense_link_rejections"]) {
    const keys = dbi
      .prepare(`SELECT purchase_key FROM ${table} WHERE purchase_key LIKE 'checking-mv:%'`)
      .all() as { purchase_key: string }[];
    for (const { purchase_key } of keys) {
      const mv = parseCheckingMv(purchase_key);
      if (!mv) continue;
      const row = movementNote.get(mv.movementId) as { note: string | null } | undefined;
      if (!row) bump(report.movement_gone, table);
      else if (!String(row.note ?? "").startsWith("import:cartola|")) bump(report.not_cartola, table);
      else bump(report.cartola_unread, table);
    }
  }

  console.log(`migration 273 expense keys: ${JSON.stringify(report)}`);
  for (const write of writes) write();
  return report;
}
