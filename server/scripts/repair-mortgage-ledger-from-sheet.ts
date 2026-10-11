/**
 * One-off: set a cuota's stored min UF (and, when given, its amortización / ext split) to the
 * figures the user typed in the mortgage sheet — the bank's posted numbers — where the ledger
 * held formula-era values (the excel import's model mínima, or a form entry made from it).
 *
 *   npx tsx scripts/repair-mortgage-ledger-from-sheet.ts --plan=<json> [--apply]
 *
 * Plan: `[{"cuota": "28", "min_uf": 11.2143, "amortizacion_clp": 107825, "amortizacion_ext_clp": 1338383}]`
 * (the split is optional; when given, both legs must still add up with interés + seguros to the
 * movement's pago, and the UF legs are recomputed at the row's uf_daily). Both `depto_payments`
 * rows of the cuota (mortgage + dividendos) are updated; movements are never touched. Report-first;
 * `--apply` writes inside one IMMEDIATE transaction. Context: PARSERS.md «Mortgage sheet».
 */
import fs from "node:fs";
import { db } from "../src/db.js";
import { ufRowOnOrBefore } from "../src/fxRates.js";
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
  kind: string;
  account_id: number;
  occurred_on: string;
  amount: number;
  min_uf: number | null;
  interes_clp: number | null;
  incendio_clp: number | null;
  desgravamen_clp: number | null;
  amortizacion_clp: number | null;
  amortizacion_uf: number | null;
  amortizacion_ext_clp: number | null;
  amortizacion_ext_uf: number | null;
};

const roundUf4 = (v: number) => Math.round(v * 1e4) / 1e4;

const updates: { row: Row; set: Record<string, number | null> }[] = [];
for (const item of plan) {
  const rows = db
    .prepare(
      `SELECT p.movement_id, p.kind, m.account_id, m.occurred_on, m.amount, p.min_uf, p.interes_clp, p.incendio_clp,
              p.desgravamen_clp, p.amortizacion_clp, p.amortizacion_uf, p.amortizacion_ext_clp, p.amortizacion_ext_uf
       FROM depto_payments p JOIN movements m ON m.id = p.movement_id WHERE p.cuota = ?`
    )
    .all(item.cuota) as Row[];
  if (rows.length !== 2) throw new Error(`cuota ${item.cuota}: expected the mortgage + dividendos rows, found ${rows.length}`);
  if (!Number.isFinite(item.min_uf) || item.min_uf <= 0) throw new Error(`cuota ${item.cuota}: bad min_uf`);
  for (const row of rows) {
    const set: Record<string, number | null> = { min_uf: item.min_uf };
    if (item.amortizacion_clp != null || item.amortizacion_ext_clp != null) {
      if (item.amortizacion_clp == null || item.amortizacion_ext_clp == null) throw new Error(`cuota ${item.cuota}: give both amortización legs`);
      const sum = (row.interes_clp ?? 0) + (row.incendio_clp ?? 0) + (row.desgravamen_clp ?? 0) + item.amortizacion_clp + item.amortizacion_ext_clp;
      if (Math.abs(sum - row.amount) > 1) throw new Error(`cuota ${item.cuota}: legs add up to ${sum}, pago ${row.amount}`);
      const uf = ufRowOnOrBefore(row.occurred_on);
      if (!uf || uf.date !== row.occurred_on) throw new Error(`cuota ${item.cuota}: no uf_daily row on ${row.occurred_on}`);
      set.amortizacion_clp = item.amortizacion_clp;
      set.amortizacion_uf = roundUf4(item.amortizacion_clp / uf.clp_per_uf);
      set.amortizacion_ext_clp = item.amortizacion_ext_clp > 0 ? item.amortizacion_ext_clp : null;
      set.amortizacion_ext_uf = item.amortizacion_ext_clp > 0 ? roundUf4(item.amortizacion_ext_clp / uf.clp_per_uf) : null;
    }
    updates.push({ row, set });
    const before = Object.keys(set).map((k) => `${k} ${String((row as Record<string, unknown>)[k])} → ${set[k]}`);
    console.log(`cuota ${item.cuota} ${row.kind.padEnd(10)} movement ${row.movement_id} ${row.occurred_on}: ${before.join(", ")}`);
  }
}

if (!apply) {
  console.log(`\n${updates.length} row(s) would change. Re-run with --apply.`);
  process.exit(0);
}

const tx = db.transaction(() => {
  for (const { row, set } of updates) {
    const cols = Object.keys(set);
    db.prepare(`UPDATE depto_payments SET ${cols.map((c) => `${c} = @${c}`).join(", ")} WHERE movement_id = @movement_id`).run({ ...set, movement_id: row.movement_id });
  }
});
tx.immediate();
for (const { row } of updates) invalidateAggregationForAccountDate(row.account_id, row.occurred_on);
console.log(`\n${updates.length} row(s) updated.`);
