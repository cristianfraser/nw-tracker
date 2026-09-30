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
import { log } from "../log.js";
import { ensureDir, resolveCfraserDir } from "../paths.js";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
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
  const client = dryRun ? null : ingestClient();
  const archiveDir = path.join(resolveCfraserDir(), "checking-ultimos-movimientos", "imported");
  for (const file of files) {
    const name = path.basename(file);
    const payload = bankAccountMovementsKind.payload.parse(santanderCheckingMovementsPayload(fs.readFileSync(file)));
    const mtime = fs.statSync(file).mtime;
    if (!client) {
      console.log(`  ${name}: ${payload.movements.length} row(s) parsed`);
    } else {
      let details: BankAccountMovementsApplyDetails;
      try {
        const result = await client.send(bankAccountMovementsKind, payload, {
          channel: "file",
          ref: name,
          label: name,
          fetched_at: mtime.toISOString(),
        });
        details = result.details as BankAccountMovementsApplyDetails;
      } catch (err) {
        log(`FAILED ${name}: ${describeIngestFailure(err)}`);
        return 1;
      }
      const archivedTo = path.join(ensureDir(archiveDir), `${mtime.toISOString().slice(0, 10)} ${name}`);
      if (fs.existsSync(archivedTo)) fs.unlinkSync(archivedTo);
      fs.renameSync(file, archivedTo);
      console.log(`  ${formatCheckingFileSummary(name, details, archivedTo)}`);
    }
    if (payload.rejected_rows.length > 0) {
      console.error(payload.rejected_rows.map((e) => `  ${name}: ${e}`).join("\n"));
      return 1;
    }
  }
  return 0;
}

process.exitCode = await main();
