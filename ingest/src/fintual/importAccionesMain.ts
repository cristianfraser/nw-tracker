/**
 * Send the dividends Fintual's «Acciones» documents itemize to the server, one
 * `broker.dividend_statement` per document; the server writes each dividend's gross and
 * withholding beside its ledger row.
 *
 *   npm run import:fintual-acciones              # report only
 *   npm run import:fintual-acciones -- --apply   # write
 *
 * Reads every PDF under `cfraser/fintual-acciones/{cartolas,certificados}/` (staged by
 * `npm run fetch:fintual-docs`). Idempotent: a breakdown already recorded from the same document
 * is reported as such. Never creates or edits a movement.
 *
 * Exit status: non-zero when a printed dividend has no ledger row or several — the broker paid
 * something the ledger does not describe, which must reach the nightly notification — or when
 * the server refuses a document or is not reachable.
 */
import path from "node:path";
import { brokerDividendStatementKind, type BrokerDividendStatementApplyDetails } from "nw-tracker-contracts";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { dividendStatementPayloadForFile, listFintualAccionesFiles, resolveFintualAccionesDir } from "./acciones.js";

const apply = process.argv.includes("--apply");

async function main(): Promise<number> {
  const files = listFintualAccionesFiles();
  if (files.cartolas.length === 0 && files.certificados.length === 0) {
    console.log(`No Fintual Acciones documents under ${resolveFintualAccionesDir()}.`);
    console.log("Run: npm run fetch:fintual-docs");
    return 0;
  }
  let written = 0;
  const conflicts: string[] = [];
  for (const [kind, list] of [
    ["cartola", files.cartolas],
    ["certificado", files.certificados],
  ] as const) {
    for (const file of list) {
      const payload = dividendStatementPayloadForFile(file, kind, apply);
      let d: BrokerDividendStatementApplyDetails;
      try {
        const result = await ingestClient().send(brokerDividendStatementKind, payload, { channel: "file", ref: path.basename(file) });
        d = result.details as BrokerDividendStatementApplyDetails;
      } catch (err) {
        console.error(`FAILED ${path.basename(file)} — ${describeIngestFailure(err)}`);
        return 1;
      }
      console.log(`\n${payload.document.name} (${kind} ${payload.document.label}): ${d.dividends.length} dividend(s)`);
      for (const row of d.dividends) {
        const p = row.dividend;
        const amounts = `gross ${p.gross.toFixed(2)} − tax ${p.withholding.toFixed(2)} = net ${p.net.toFixed(2)} usd`;
        const extras = [
          p.per_share != null ? `@ ${p.per_share}` : null,
          p.position_qty != null ? `× ${p.position_qty}` : null,
          p.withholding_rate_pct != null ? `${p.withholding_rate_pct}%` : null,
          p.record_date ? `rec ${p.record_date}` : null,
        ]
          .filter(Boolean)
          .join(" ");
        const state = row.conflict
          ? `  [CONFLICT: ${row.conflict}]`
          : row.already_recorded
            ? `  [recorded on movement ${row.movement_id}]`
            : `  [→ movement ${row.movement_id}]`;
        if (row.conflict) conflicts.push(`${payload.document.name}: ${p.date} ${p.symbol} ${amounts} — ${row.conflict}`);
        console.log(`  ${p.date}  ${p.symbol.padEnd(8)} ${amounts}${extras ? `  (${extras})` : ""}${state}`);
      }
      for (const i of payload.interest) console.log(`  ${i.date}  interest ${i.amount.toFixed(2)} usd  (${i.description}) — reported only`);
      if (apply) {
        const changed = d.dividends.filter((r) => r.outcome != null && r.outcome !== "unchanged");
        written += changed.length;
        for (const r of changed) console.log(`  → dividend breakdown ${r.outcome} on movement ${r.movement_id}`);
        if (changed.length === 0 && d.dividends.length > 0) console.log("  → nothing new");
      }
    }
  }
  console.log(apply ? `\n${written} dividend breakdown(s) written.` : "\nReport only — nothing written. Re-run with --apply.");
  if (conflicts.length > 0) {
    console.log(`\n${conflicts.length} CONFLICT(S) — the documents and the ledger disagree; reconcile by hand:`);
    for (const c of conflicts) console.log(`  ${c}`);
    return 1;
  }
  return 0;
}

process.exitCode = await main();
