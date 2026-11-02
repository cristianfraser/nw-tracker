/**
 * One-off: set a cuota's stored min payment (UF) (and, when given, its amortización / ext split in
 * pesos) to the figures the user typed in the mortgage sheet — the bank's posted numbers — where
 * the ledger held formula-era values (the excel import's model mínima, or a form entry made from it).
 *
 *   npx tsx scripts/repair-mortgage-ledger-from-sheet.ts --plan=<json> [--apply]
 *
 * Plan: `[{"cuota": "28", "min_uf": 11.2143, "amortizacion_clp": 107825, "amortizacion_ext_clp": 1338383}]`
 * (the split is optional; when given, both legs must still add up with interés + seguros to the
 * movement's pago; their UF figures are derived when the ledger is read). Both `loan_payments`
 * rows of the cuota (loan + property leg) are updated; movements are never touched. Report-first;
 * `--apply` writes inside one IMMEDIATE transaction. Context: PARSERS.md «Mortgage sheet».
 */
import fs from "node:fs";
import { db } from "../src/db.js";
import { invalidateAggregationForAccountDate } from "../src/aggregationCache.js";

type PlanItem = { cuota: string; min_uf: number; amortizacion_clp?: number; amortizacion_ext_clp?: number };

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const apply = process.argv.includes("--apply");
const planPath = arg("plan");
if (!planPath) {
  console.error("--plan=<json> is required");
  process.exit(2);
}
const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as PlanItem[];
if (!Array.isArray(plan) || plan.length === 0) throw new Error("plan must be a non-empty list");

type Row = {
  movement_id: number;
  leg: string;
  account_id: number;
  occurred_on: string;
  amount: number;
  loan_currency: string;
  payment_currency: string;
  min_payment: number | null;
  interest: number | null;
  insurance_fire: number | null;
  insurance_life: number | null;
  principal: number | null;
  extra_principal: number | null;
};

const updates: { row: Row; set: Record<string, number | null> }[] = [];
for (const item of plan) {
  const rows = db
    .prepare(
      `SELECT p.movement_id, p.leg, m.account_id, m.occurred_on, m.amount, p.loan_currency, p.payment_currency,
              p.min_payment, p.interest, p.insurance_fire, p.insurance_life, p.principal, p.extra_principal
       FROM loan_payments p JOIN movements m ON m.id = p.movement_id WHERE p.cuota = ?`
    )
    .all(item.cuota) as Row[];
  if (rows.length !== 2) throw new Error(`cuota ${item.cuota}: expected the loan + property rows, found ${rows.length}`);
  if (!Number.isFinite(item.min_uf) || item.min_uf <= 0) throw new Error(`cuota ${item.cuota}: bad min_uf`);
  for (const row of rows) {
    if (row.loan_currency !== "uf" || row.payment_currency !== "clp") {
      throw new Error(`cuota ${item.cuota}: a UF loan paid in pesos expected, got ${row.loan_currency} / ${row.payment_currency}`);
    }
    const set: Record<string, number | null> = { min_payment: item.min_uf };
    if (item.amortizacion_clp != null || item.amortizacion_ext_clp != null) {
      if (item.amortizacion_clp == null || item.amortizacion_ext_clp == null) throw new Error(`cuota ${item.cuota}: give both amortización legs`);
      const sum = (row.interest ?? 0) + (row.insurance_fire ?? 0) + (row.insurance_life ?? 0) + item.amortizacion_clp + item.amortizacion_ext_clp;
      if (Math.abs(sum - row.amount) > 1) throw new Error(`cuota ${item.cuota}: legs add up to ${sum}, pago ${row.amount}`);
      set.principal = item.amortizacion_clp;
      set.extra_principal = item.amortizacion_ext_clp > 0 ? item.amortizacion_ext_clp : null;
    }
    updates.push({ row, set });
    const before = Object.keys(set).map((k) => `${k} ${String((row as Record<string, unknown>)[k])} → ${set[k]}`);
    console.log(`cuota ${item.cuota} ${row.leg.padEnd(8)} movement ${row.movement_id} ${row.occurred_on}: ${before.join(", ")}`);
  }
}

if (!apply) {
  console.log(`\n${updates.length} row(s) would change. Re-run with --apply.`);
  process.exit(0);
}

const tx = db.transaction(() => {
  for (const { row, set } of updates) {
    const cols = Object.keys(set);
    db.prepare(`UPDATE loan_payments SET ${cols.map((c) => `${c} = @${c}`).join(", ")} WHERE movement_id = @movement_id`).run({ ...set, movement_id: row.movement_id });
  }
});
tx.immediate();
for (const { row } of updates) invalidateAggregationForAccountDate(row.account_id, row.occurred_on);
console.log(`\n${updates.length} row(s) updated.`);
