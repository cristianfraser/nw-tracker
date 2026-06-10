import { db } from "./db.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { listMovementBalanceCashAccountIds } from "./movementBalanceCashAccounts.js";
import type { FlowCcExpenseLineRow } from "./flowsCreditCardExpenses.js";

export type CcExpenseBigGroupRow = {
  slug: string;
  label: string;
  sort_order: number;
};

export function purchaseBigGroupMapKey(accountId: number, purchaseKey: string): string {
  return `${accountId}|${purchaseKey}`;
}

function accountAllowedForExpensePurchaseBigGroup(accountId: number): boolean {
  if (listCreditCardMasterAccountIds().includes(accountId)) return true;
  return listMovementBalanceCashAccountIds().includes(accountId);
}

export function slugFromBigGroupLabel(label: string): string {
  const base = label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
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

export function loadCcExpensePurchaseBigGroups(accountIds: number[]): Map<string, string> {
  const out = new Map<string, string>();
  if (accountIds.length === 0) return out;
  const ph = accountIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT account_id, purchase_key, group_slug
       FROM cc_expense_purchase_big_groups
       WHERE account_id IN (${ph})`
    )
    .all(...accountIds) as { account_id: number; purchase_key: string; group_slug: string }[];
  for (const row of rows) {
    out.set(purchaseBigGroupMapKey(row.account_id, row.purchase_key), row.group_slug);
  }
  return out;
}

export function countPurchasesInBigGroup(slug: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM cc_expense_purchase_big_groups WHERE group_slug = ?`)
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
  accountId: number;
  purchaseKey: string;
  groupSlug: string | null | undefined;
}): { group_slug: string | null } {
  const purchaseKey = String(opts.purchaseKey ?? "").trim();
  if (!purchaseKey) {
    throw new Error("purchase_key required");
  }
  if (!accountAllowedForExpensePurchaseBigGroup(opts.accountId)) {
    throw new Error("account not in credit card expenses scope");
  }

  const groupSlug = opts.groupSlug != null ? String(opts.groupSlug).trim() : "";
  if (!groupSlug) {
    db.prepare(
      `DELETE FROM cc_expense_purchase_big_groups WHERE account_id = ? AND purchase_key = ?`
    ).run(opts.accountId, purchaseKey);
    return { group_slug: null };
  }

  const group = db
    .prepare(`SELECT slug FROM cc_expense_big_groups WHERE slug = ?`)
    .get(groupSlug) as { slug: string } | undefined;
  if (!group) {
    throw new Error("big group not found");
  }

  db.prepare(
    `INSERT INTO cc_expense_purchase_big_groups (account_id, purchase_key, group_slug)
     VALUES (?, ?, ?)
     ON CONFLICT(account_id, purchase_key) DO UPDATE SET group_slug = excluded.group_slug`
  ).run(opts.accountId, purchaseKey, groupSlug);
  return { group_slug: groupSlug };
}

export type FlowCcExpenseLineBeforeBigGroup = Omit<FlowCcExpenseLineRow, "big_group_slug">;

export function enrichFlowLinesWithBigGroups(
  lines: FlowCcExpenseLineBeforeBigGroup[],
  groupsByKey?: Map<string, string>
): FlowCcExpenseLineRow[] {
  const accountIds = [...new Set(lines.map((ln) => ln.account_id))];
  const groups =
    groupsByKey ??
    loadCcExpensePurchaseBigGroups(
      accountIds.length > 0 ? accountIds : listCreditCardMasterAccountIds()
    );
  return lines.map((ln) => {
    const slug =
      groups.get(purchaseBigGroupMapKey(ln.account_id, ln.purchase_key)) ?? null;
    return { ...ln, big_group_slug: slug };
  });
}
