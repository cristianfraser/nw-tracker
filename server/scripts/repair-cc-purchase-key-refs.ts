// Repair (2026-07-27): purchase_key references left dangling by the manual-twin collapse of
// 839a967 — the twin sweep deleted manual plans whose keys were embedded in
// cc_facturado_financing_link_purchases (the Lider facturado-financing link stopped
// projecting), cc_expense_purchase_notes and cc_expense_purchase_big_groups. The reconcile
// now migrates these on delete; this script remaps rows already orphaned: any installment-h
// key that no current plan produces is re-pointed at the unique surviving plan with the same
// account, cuota count, total amount (when the key carries one) and purchase date ±2 days.
// Report by default; --apply rewrites.
// Usage: npx tsx scripts/repair-cc-purchase-key-refs.ts [--apply]
import { db } from "../src/db.js";
import {
  legacyInstallmentHPurchaseKey,
  parseInstallmentHPurchaseKey,
  stableInstallmentHPurchaseKeyFromLedgerArgs,
} from "../src/ccExpenseCategories.js";

const APPLY = process.argv.includes("--apply");

type PlanRow = {
  id: number;
  account_id: number;
  purchase_date: string;
  total_amount_clp: number;
  cuotas_totales: number;
  merchant: string | null;
};

const plans = db
  .prepare(
    `SELECT id, account_id, purchase_date, total_amount_clp, cuotas_totales, merchant
     FROM cc_installment_purchases`
  )
  .all() as PlanRow[];

const planKeys = new Set<string>();
for (const p of plans) {
  const modern = stableInstallmentHPurchaseKeyFromLedgerArgs({
    accountId: p.account_id,
    purchaseDateIso: p.purchase_date,
    cuotasTotales: p.cuotas_totales,
    totalAmountClp: p.total_amount_clp,
    merchant: p.merchant,
  });
  if (modern) {
    planKeys.add(`${p.account_id}|${modern}`);
    const legacy = legacyInstallmentHPurchaseKey(modern);
    if (legacy) planKeys.add(`${p.account_id}|${legacy}`);
  }
}

function daysApart(aIso: string, bIso: string): number {
  return Math.abs(Date.parse(`${aIso}T00:00:00Z`) - Date.parse(`${bIso}T00:00:00Z`)) / 86_400_000;
}

/** Unique surviving plan for a dangling key, or null (ambiguous / none). */
function resolveDanglingKey(accountId: number, key: string): { plan: PlanRow; newKey: string } | null {
  const parsed = parseInstallmentHPurchaseKey(key);
  if (!parsed) return null;
  const candidates = plans.filter(
    (p) =>
      p.account_id === accountId &&
      p.cuotas_totales === parsed.nroTotal &&
      (parsed.totalClp == null || p.total_amount_clp === parsed.totalClp) &&
      daysApart(p.purchase_date, parsed.purchaseIso) <= 2
  );
  if (candidates.length !== 1) return null;
  const plan = candidates[0]!;
  const newKey = stableInstallmentHPurchaseKeyFromLedgerArgs({
    accountId: plan.account_id,
    purchaseDateIso: plan.purchase_date,
    cuotasTotales: plan.cuotas_totales,
    totalAmountClp: plan.total_amount_clp,
    merchant: plan.merchant,
  });
  return newKey ? { plan, newKey } : null;
}

const TABLES = [
  {
    table: "cc_facturado_financing_link_purchases",
    keyCol: "financing_purchase_key",
    accountCol: "financing_account_id",
  },
  { table: "cc_expense_purchase_notes", keyCol: "purchase_key", accountCol: "account_id" },
  { table: "cc_expense_purchase_big_groups", keyCol: "purchase_key", accountCol: "account_id" },
] as const;

for (const { table, keyCol, accountCol } of TABLES) {
  const rows = db
    .prepare(`SELECT ${accountCol} AS account_id, ${keyCol} AS key FROM ${table} WHERE ${keyCol} LIKE 'installment-h:%'`)
    .all() as { account_id: number; key: string }[];
  for (const row of rows) {
    if (planKeys.has(`${row.account_id}|${row.key}`)) continue;
    const hit = resolveDanglingKey(row.account_id, row.key);
    if (!hit) {
      console.log(`${table}: DANGLING (no unique plan match) account ${row.account_id} key ${row.key}`);
      continue;
    }
    console.log(
      `${table}: ${APPLY ? "rewriting" : "would rewrite"} account ${row.account_id}\n  ${row.key}\n  → ${hit.newKey} (plan #${hit.plan.id} «${hit.plan.merchant}»)`
    );
    if (APPLY) {
      db.prepare(
        `UPDATE OR IGNORE ${table} SET ${keyCol} = ? WHERE ${accountCol} = ? AND ${keyCol} = ?`
      ).run(hit.newKey, row.account_id, row.key);
      db.prepare(`DELETE FROM ${table} WHERE ${accountCol} = ? AND ${keyCol} = ?`).run(
        row.account_id,
        row.key
      );
    }
  }
}

// NOTE: cc_expense_unique_purchases is deliberately NOT swept here — installment-h keys there
// can belong to statement-line ctx keys with no cc_installment_purchases row (old cards), so
// "no plan produces this key" does not imply stale. The reconcile now deletes a twin's modern
// + legacy unique rows at collapse time; the one historical leftover (twin 149's legacy key)
// is inert for resolution (merchant key matches nothing) and is left in place.
