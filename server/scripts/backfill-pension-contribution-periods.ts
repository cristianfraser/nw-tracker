/**
 * One-time: the months the AFP and AFC contributions written before migration 223 pay, read from
 * the notes their writers gave them («AFP cotización — período 2019-12, 2020-01 | …», «AFC
 * cotización — período 2021-01 (pago …)»), into `pension_contribution_periods`. Going forward the
 * writers record the month themselves; nothing reads the notes.
 *
 *   npx tsx scripts/backfill-pension-contribution-periods.ts [--extra=<movement id>:<YYYY-MM>,…] [--apply]
 *
 * `--extra` names contributions whose note does not carry the month (a payroll APV deposit entered
 * by hand). Report-first: without --apply it lists what it would write and writes nothing.
 */
import { db } from "../src/db.js";
import { recordContributionPeriods } from "../src/pensionContributionPeriods.js";

const apply = process.argv.includes("--apply");
const extraArg = process.argv.find((a) => a.startsWith("--extra="))?.slice("--extra=".length) ?? "";

const RE_NOTE =
  /^(AFP cotización|AFP abono AFC\/SLP|AFP reliquidaciones\/comisiones netas|AFC cotización) — período (\d{4}-\d{2}(?:, \d{4}-\d{2})*)/;

type Row = { id: number; account_id: number | null; to_account_id: number | null; note: string | null };

const rows = db
  .prepare(
    `SELECT id, account_id, to_account_id, note FROM movements
      WHERE note LIKE 'AFP cotización — período%' OR note LIKE 'AFP abono AFC/SLP — período%'
         OR note LIKE 'AFP reliquidaciones/comisiones netas — período%' OR note LIKE 'AFC cotización — período%'
      ORDER BY id`
  )
  .all() as Row[];

const plan: { movement_id: number; periods: string[]; source: string }[] = [];
for (const r of rows) {
  const m = RE_NOTE.exec(r.note ?? "");
  if (!m) throw new Error(`movement ${r.id}: note does not name its months: ${r.note}`);
  if (r.account_id == null) throw new Error(`movement ${r.id}: a contribution note on a transfer`);
  plan.push({ movement_id: r.id, periods: m[2]!.split(", "), source: m[1]! });
}
for (const pair of extraArg.split(",").filter(Boolean)) {
  const [id, period] = pair.split(":");
  const mid = Number(id);
  if (!db.prepare(`SELECT 1 FROM movements WHERE id = ?`).get(mid)) throw new Error(`--extra: no movement ${id}`);
  plan.push({ movement_id: mid, periods: [period!], source: "extra" });
}

const bySource = new Map<string, number>();
for (const p of plan) bySource.set(p.source, (bySource.get(p.source) ?? 0) + 1);
for (const [s, n] of bySource) console.log(`${String(n).padStart(4)}  ${s}`);
const multi = plan.filter((p) => p.periods.length > 1);
for (const p of multi) console.log(`  movement ${p.movement_id} pays ${p.periods.join(" + ")}`);
const existing = (db.prepare(`SELECT COUNT(*) AS n FROM pension_contribution_periods`).get() as { n: number }).n;
console.log(`${plan.length} contribution(s), ${plan.reduce((s, p) => s + p.periods.length, 0)} month(s); ${existing} row(s) already stored`);

if (!apply) {
  console.log("report only — pass --apply to write");
} else {
  db.transaction(() => {
    for (const p of plan) recordContributionPeriods(p.movement_id, p.periods);
  })();
  const after = (db.prepare(`SELECT COUNT(*) AS n FROM pension_contribution_periods`).get() as { n: number }).n;
  console.log(`written: ${after - existing} new row(s), ${after} total`);
}
