/**
 * Send the checking account's «ultimos movimientos-Cuenta Corriente.xlsx» files staged in the
 * inbox (`fetch:santander` drops them there) to the server, oldest first, and archive each.
 *
 *   npm run import:checking-movements -w nw-tracker-ingest              # send + archive
 *   npm run import:checking-movements -w nw-tracker-ingest -- --dry-run # parse only
 *
 * The download's name is constant, so the archived copy is date-stamped from the file's mtime
 * (the fetch day); a same-day re-run overwrites its own archive copy. Rows the parser could not
 * read are reported after the file is applied and archived, and fail the step — as the server's
 * inbox import did.
 */
import fs from "node:fs";
import path from "node:path";
import { bankAccountMovementsKind, type BankAccountMovementsApplyDetails } from "nw-tracker-contracts";
import { resolveCfraserDir } from "../paths.js";
import { ingestClient } from "../serverApi.js";
import { sendStaged } from "../stagedFiles.js";
import {
  formatCheckingFileSummary,
  santanderCheckingMovementsPayload,
  stagedCheckingMovementFiles,
} from "./checkingMovements.js";

const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<number> {
  const files = stagedCheckingMovementFiles();
  if (files.length === 0) {
    console.log("=== Checking ultimos movimientos xlsx (none in inbox) ===");
    return 0;
  }
  console.log(`=== Import checking ultimos movimientos xlsx${dryRun ? " (dry run)" : ""} ===`);
  const docs = files.map((file) => ({
    file,
    name: path.basename(file),
    mtime: fs.statSync(file).mtime,
    payload: bankAccountMovementsKind.payload.parse(santanderCheckingMovementsPayload(fs.readFileSync(file))),
  }));
  const rejected = (d: (typeof docs)[number]) => d.payload.rejected_rows.map((e) => `  ${d.name}: ${e}`);
  if (dryRun) {
    for (const d of docs) console.log(`  ${d.name}: ${d.payload.movements.length} row(s) parsed`);
  } else {
    const client = ingestClient();
    const archiveDir = path.join(resolveCfraserDir(), "checking-ultimos-movimientos", "imported");
    const { exitCode } = await sendStaged(docs, {
      path: (d) => d.file,
      send: (d) =>
        client.send(bankAccountMovementsKind, d.payload, { channel: "file", ref: d.name, label: d.name, fetched_at: d.mtime.toISOString() }),
      // The download's name is constant: the archived copy is dated by the fetch day.
      archive: (d) => ({ dir: archiveDir, name: `${d.mtime.toISOString().slice(0, 10)} ${d.name}` }),
      report: (d, result, archivedTo) =>
        console.log(`  ${formatCheckingFileSummary(d.name, result.details as BankAccountMovementsApplyDetails, archivedTo)}`),
    });
    if (exitCode !== 0) return exitCode;
  }
  // Rows the parser could not read fail the step once their file is applied and archived.
  const unread = docs.flatMap(rejected);
  if (unread.length > 0) {
    console.error(unread.join("\n"));
    return 1;
  }
  return 0;
}

process.exitCode = await main();
