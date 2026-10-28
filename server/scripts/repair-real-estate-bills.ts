/**
 * One-off repairs of place bills (Gastos › Inmuebles) from a plan file. Report-first: without
 * `--apply` everything runs inside a transaction that is rolled back, so the report IS the result.
 *
 *   npx tsx scripts/repair-real-estate-bills.ts --plan=<json> [--apply]   (from server/)
 *
 * Plan: a JSON array of steps, run in order —
 *   { "delete": <expense_entries.id>, "reason": "…" }
 *   { "remonth": <expense_entries.id>, "bill_month": "YYYY-MM" }
 *   { "assign": "<purchase_key>", "place": "<slug>", "kind": "<bill kind>", "bill_month": "YYYY-MM" }
 *   { "cover": <expense_entries.id>, "months": <n> }        (the payment covers n months ending at its bill month)
 *   { "refund": <movements.id>, "category": "<slug>" }      (a checking credit that returned spending)
 *
 * A bill exists only when a purchase backs it: `assign` creates it from the purchase (amount taken
 * from the line), `delete` removes one that has none. Plans name personal data — keep them in cfraser/.
 */
import { readFileSync } from "node:fs";
import { markCheckingExpenseRefund } from "../src/checkingExpenseRefunds.js";
import { db } from "../src/db.js";
import {
  assignPurchaseToRealEstateExpense,
  deleteRealEstateExpenseEntry,
  loadExpectationById,
  updateRealEstateExpenseBillMonth,
  updateRealEstateExpenseMonthsCovered,
} from "../src/realEstateExpenseMatching.js";

type Step =
  | { delete: number; reason?: string }
  | { remonth: number; bill_month: string }
  | { assign: string; place: string; kind: string; bill_month: string }
  | { cover: number; months: number }
  | { refund: number; category: string };

const planArg = process.argv.find((a) => a.startsWith("--plan="));
if (!planArg) throw new Error("--plan=<json> required");
const apply = process.argv.includes("--apply");
const steps = JSON.parse(readFileSync(planArg.slice("--plan=".length), "utf8")) as Step[];
if (!Array.isArray(steps) || steps.length === 0) throw new Error("plan must be a non-empty array");

function linkOf(entryId: number): string | null {
  return (
    (db.prepare(`SELECT purchase_key FROM real_estate_expense_links WHERE expense_entry_id = ?`).get(entryId) as
      | { purchase_key: string }
      | undefined)?.purchase_key ?? null
  );
}

function describeEntry(entryId: number): string {
  const e = loadExpectationById(entryId);
  if (!e) throw new Error(`expense entry ${entryId} not found`);
  return `#${entryId} ${e.account_slug} ${e.spent_on.slice(0, 7)} ${e.category} $${e.amount_clp} link=${linkOf(entryId) ?? "none"}`;
}

const ROLLBACK = new Error("report only — rolled back");

try {
  db.transaction(() => {
    for (const step of steps) {
      if ("delete" in step) {
        console.log(`delete  ${describeEntry(step.delete)}${step.reason ? ` — ${step.reason}` : ""}`);
        deleteRealEstateExpenseEntry(step.delete);
      } else if ("remonth" in step) {
        const before = describeEntry(step.remonth);
        updateRealEstateExpenseBillMonth(step.remonth, step.bill_month);
        console.log(`remonth ${before} → ${step.bill_month}`);
      } else if ("assign" in step) {
        const { expense_entry_id } = assignPurchaseToRealEstateExpense({
          purchaseKey: step.assign,
          accountSlug: step.place,
          kind: step.kind,
          billMonth: step.bill_month,
        });
        console.log(`assign  ${step.assign} → ${describeEntry(expense_entry_id)}`);
      } else if ("cover" in step) {
        const before = describeEntry(step.cover);
        updateRealEstateExpenseMonthsCovered(step.cover, step.months);
        console.log(`cover   ${before} → ${step.months} month(s) ending at its bill month`);
      } else if ("refund" in step) {
        const mv = db.prepare(`SELECT occurred_on, amount, note FROM movements WHERE id = ?`).get(step.refund) as
          | { occurred_on: string; amount: number; note: string | null }
          | undefined;
        if (!mv) throw new Error(`movement ${step.refund} not found`);
        markCheckingExpenseRefund(step.refund, step.category);
        console.log(`refund  movement ${step.refund} ${mv.occurred_on} $${mv.amount} → refund in '${step.category}'`);
      } else {
        throw new Error(`unknown plan step: ${JSON.stringify(step)}`);
      }
    }
    if (!apply) throw ROLLBACK;
  }).immediate();
  console.log(`applied ${steps.length} step(s)`);
} catch (e) {
  if (e !== ROLLBACK) throw e;
  console.log(`\nreport only (${steps.length} step(s)); re-run with --apply to write`);
}
