/**
 * Write dividend breakdowns (gross / withholding) from Fintual's «Acciones» documents.
 *
 *   npm run import:fintual-acciones -w nw-tracker-server              # report only
 *   npm run import:fintual-acciones -w nw-tracker-server -- --apply   # write
 *
 * Reads every PDF under `cfraser/fintual-acciones/{cartolas,certificados}/` (staged by
 * `npm run fetch:fintual-docs` in ingest/), pairs each printed dividend with its ledger
 * `dividend_payout` row and writes `movement_dividend_details`. Idempotent: a breakdown already
 * recorded from the same document is reported as such and touched only if it changed. Never
 * creates or edits a movement.
 *
 * Exit status: non-zero when a printed dividend has no ledger row or several — the broker paid
 * something the ledger does not describe, which must reach the nightly notification.
 */
import {
  applyFintualDividendDetails,
  listFintualAccionesFiles,
  planFintualAccionesFile,
  resolveFintualAccionesDir,
} from "../src/fintualAccionesImport.js";

const apply = process.argv.includes("--apply");
const files = listFintualAccionesFiles();

if (files.cartolas.length === 0 && files.certificados.length === 0) {
  console.log(`No Fintual Acciones documents under ${resolveFintualAccionesDir()}.`);
  console.log("Run: npm run fetch:fintual-docs (ingest/)");
  process.exit(0);
}

let written = 0;
const conflicts: string[] = [];

for (const [kind, list] of [
  ["cartola", files.cartolas],
  ["certificado", files.certificados],
] as const) {
  for (const file of list) {
    const planned = planFintualAccionesFile(file, kind);
    console.log(`\n${planned.file} (${kind} ${planned.label}): ${planned.plans.length} dividend(s)`);
    for (const plan of planned.plans) {
      const p = plan.printed;
      const amounts = `gross ${p.gross.toFixed(2)} − tax ${p.withholding.toFixed(2)} = net ${p.net.toFixed(2)} usd`;
      const extras = [
        p.per_share != null ? `@ ${p.per_share}` : null,
        p.position_qty != null ? `× ${p.position_qty}` : null,
        p.withholding_rate_pct != null ? `${p.withholding_rate_pct}%` : null,
        p.record_date ? `rec ${p.record_date}` : null,
      ]
        .filter(Boolean)
        .join(" ");
      const state = plan.conflict
        ? `  [CONFLICT: ${plan.conflict}]`
        : plan.already_recorded
          ? `  [recorded on movement ${plan.movement_id}]`
          : `  [→ movement ${plan.movement_id}]`;
      if (plan.conflict) conflicts.push(`${planned.file}: ${p.date} ${p.symbol} ${amounts} — ${plan.conflict}`);
      console.log(`  ${p.date}  ${p.symbol.padEnd(8)} ${amounts}${extras ? `  (${extras})` : ""}${state}`);
    }
    for (const i of planned.interest) {
      console.log(`  ${i.trade_date}  interest ${i.amount.toFixed(2)} usd  (${i.description}) — reported only`);
    }
    if (apply) {
      const outcomes = applyFintualDividendDetails(planned.plans);
      const changed = outcomes.filter((o) => o.outcome !== "unchanged");
      written += changed.length;
      for (const o of changed) console.log(`  → dividend breakdown ${o.outcome} on movement ${o.movement_id}`);
      if (changed.length === 0 && planned.plans.length > 0) console.log("  → nothing new");
    }
  }
}

console.log(apply ? `\n${written} dividend breakdown(s) written.` : "\nReport only — nothing written. Re-run with --apply.");

if (conflicts.length > 0) {
  console.log(`\n${conflicts.length} CONFLICT(S) — the documents and the ledger disagree; reconcile by hand:`);
  for (const c of conflicts) console.log(`  ${c}`);
  process.exitCode = 1;
}
