import { foldAccents } from "nw-tracker-contracts";
import { expenseKeyKind } from "./expenseKeys.js";
import { db } from "./db.js";
import { keyedRowsSql, keyTarget, TARGET_WHERE, targetParams } from "./flows/flowKeyedAssignments.js";

export type CcExpenseBigGroupRow = {
  slug: string;
  label: string;
  sort_order: number;
};


export function slugFromBigGroupLabel(label: string): string {
  const base = foldAccents(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  if (!base) {
    throw new Error("label required");
  }
  let slug = base;
  let n = 2;
  while (db.prepare(`SELECT 1 FROM cc_expense_big_groups WHERE slug = ?`).get(slug)) {
    slug = `${base}_${n}`;
    n += 1;
  }
  return slug;
}

export function listCcExpenseBigGroups(): CcExpenseBigGroupRow[] {
  return db
    .prepare(
      `SELECT slug, label, sort_order
       FROM cc_expense_big_groups
       ORDER BY sort_order, label, slug`
    )
    .all() as CcExpenseBigGroupRow[];
}

/**
 * Purchase key → big group. A big group belongs to the expense — its flow (`flow_big_groups`,
 * migration 282), whichever account paid it; read under the key its line carries.
 */
export function loadCcExpensePurchaseBigGroups(): Map<string, string> {
  const rows = db
    .prepare(`SELECT purchase_key, group_slug FROM ${keyedRowsSql("flow_big_groups", ["group_slug"])}`)
    .all() as { purchase_key: string; group_slug: string }[];
  return new Map(rows.map((r) => [r.purchase_key, r.group_slug]));
}

export function countPurchasesInBigGroup(slug: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM flow_big_groups WHERE group_slug = ?`)
    .get(slug) as { n: number };
  return row.n;
}

export function createCcExpenseBigGroup(label: string): CcExpenseBigGroupRow {
  const trimmed = String(label ?? "").trim();
  if (!trimmed) {
    throw new Error("label required");
  }
  const slug = slugFromBigGroupLabel(trimmed);
  const maxSort = db
    .prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM cc_expense_big_groups`)
    .get() as { m: number };
  db.prepare(
    `INSERT INTO cc_expense_big_groups (slug, label, sort_order) VALUES (?, ?, ?)`
  ).run(slug, trimmed, maxSort.m + 10);
  return { slug, label: trimmed, sort_order: maxSort.m + 10 };
}

export function renameCcExpenseBigGroup(slug: string, label: string): CcExpenseBigGroupRow {
  const trimmed = String(label ?? "").trim();
  if (!trimmed) {
    throw new Error("label required");
  }
  const existing = db
    .prepare(`SELECT slug, sort_order FROM cc_expense_big_groups WHERE slug = ?`)
    .get(slug) as { slug: string; sort_order: number } | undefined;
  if (!existing) {
    throw new Error("big group not found");
  }
  db.prepare(`UPDATE cc_expense_big_groups SET label = ? WHERE slug = ?`).run(trimmed, slug);
  return { slug, label: trimmed, sort_order: existing.sort_order };
}

export function deleteCcExpenseBigGroup(slug: string): void {
  const n = countPurchasesInBigGroup(slug);
  if (n > 0) {
    throw new Error(`big group still has ${n} purchase(s)`);
  }
  const result = db.prepare(`DELETE FROM cc_expense_big_groups WHERE slug = ?`).run(slug);
  if (result.changes === 0) {
    throw new Error("big group not found");
  }
}

export function setCcExpensePurchaseBigGroup(opts: {
  purchaseKey: string;
  groupSlug: string | null | undefined;
}): { group_slug: string | null } {
  const purchaseKey = String(opts.purchaseKey ?? "").trim();
  if (!purchaseKey) {
    throw new Error("purchase_key required");
  }
  if (expenseKeyKind(purchaseKey) === "payslip") {
    throw new Error("payroll deductions take no big group");
  }

  const groupSlug = opts.groupSlug != null ? String(opts.groupSlug).trim() : "";
  if (!groupSlug) {
    const at = keyTarget(purchaseKey, false);
    if (at) db.prepare(`DELETE FROM flow_big_groups WHERE ${TARGET_WHERE}`).run(...targetParams(at));
    return { group_slug: null };
  }

  const group = db
    .prepare(`SELECT slug FROM cc_expense_big_groups WHERE slug = ?`)
    .get(groupSlug) as { slug: string } | undefined;
  if (!group) {
    throw new Error("big group not found");
  }

  db.prepare(
    `INSERT INTO flow_big_groups (flow_id, portion, piece_seq, group_slug)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(flow_id, portion, piece_seq) DO UPDATE SET group_slug = excluded.group_slug`
  ).run(...targetParams(keyTarget(purchaseKey, true)), groupSlug);
  return { group_slug: groupSlug };
}

export function enrichFlowLinesWithBigGroups<T extends { purchase_key: string }>(
  lines: T[],
  groupsByKey?: Map<string, string>
): (T & { big_group_slug: string | null })[] {
  const groups = groupsByKey ?? loadCcExpensePurchaseBigGroups();
  return lines.map((ln) => ({ ...ln, big_group_slug: groups.get(ln.purchase_key) ?? null }));
}
