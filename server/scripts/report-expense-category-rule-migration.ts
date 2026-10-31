/**
 * Report only: what migration 252 will do to the category rules — the per-account merchant rules
 * merged into global rules keyed on the vendor, and every vendor whose old rules disagree (the
 * category most rules carry wins). Opens the database file read-only and never through `db.ts`,
 * which would apply the migration.
 *
 *   npx tsx scripts/report-expense-category-rule-migration.ts --db=data/nw-tracker.db
 */
import Database from "better-sqlite3";
import { planExpenseCategoryRuleMigration } from "../src/expenseCategoryRulesMigration.js";

const dbArg = process.argv.find((a) => a.startsWith("--db="))?.slice(5);
if (!dbArg) throw new Error("pass --db=<path to the database file>");
const dbi = new Database(dbArg, { readonly: true, fileMustExist: true });

const slugById = new Map(
  (dbi.prepare(`SELECT id, slug FROM cc_expense_categories`).all() as { id: number; slug: string }[]).map((r) => [r.id, r.slug])
);
const plan = planExpenseCategoryRuleMigration(dbi);
if (plan.length === 0) {
  console.log("No per-account merchant rules: the migration has run already, or there is nothing to convert.");
  process.exit(0);
}
const oldRows = plan.reduce((n, r) => n + r.sources.length, 0);
console.log(`${oldRows} per-account rules → ${plan.length} global vendor rules.`);

const merged = plan.filter((r) => new Set(r.sources.map((s) => s.merchant_key)).size > 1);
console.log(`\nVendors that join several bank names (${merged.length}):`);
for (const r of merged) {
  const names = [...new Set(r.sources.map((s) => s.merchant_key))];
  console.log(`  ${r.vendor} → ${slugById.get(r.category_id)}  ⇐ ${names.join(" | ")}`);
}

const conflicts = plan.filter((r) => r.conflict);
console.log(`\nConflicts (${conflicts.length}) — the chosen category first:`);
for (const r of conflicts) {
  const byCat = new Map<number, string[]>();
  for (const s of r.sources) byCat.set(s.category_id, [...(byCat.get(s.category_id) ?? []), `${s.merchant_key} (acct ${s.account_id})`]);
  console.log(`  ${r.vendor} → ${slugById.get(r.category_id)}`);
  for (const [cat, srcs] of byCat) console.log(`      ${slugById.get(cat)}: ${srcs.join(", ")}`);
}
