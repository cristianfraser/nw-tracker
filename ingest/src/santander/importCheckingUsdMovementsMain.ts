/**
 * Send the dollar cuenta corriente's captures (`fetch:santander`'s `checking-usd-movements` step
 * writes one per session under `cfraser/santander-captures/<stamp>-usd/`) to the server, oldest
 * first, and archive each under `santander-captures/imported/`.
 *
 *   npm run import:checking-usd-movements -w nw-tracker-ingest              # send + archive
 *   npm run import:checking-usd-movements -w nw-tracker-ingest -- --dry-run # decode only
 *
 * The server confirms the rows against the ledger and never inserts (`bank_account.movements`
 * in dollars): a row no ledger transfer explains is reported back as unexplained, and the step
 * fails on it after every capture was sent and archived — the row is one to enter by hand (a
 * card payment, a conversion), and the next capture confirms it.
 */
import fs from "node:fs";
import path from "node:path";
import { bankAccountMovementsKind, type UsdAccountMovementsApplyDetails } from "nw-tracker-contracts";
import { loadBankConfig } from "../config.js";
import { log } from "../log.js";
import { ensureDir, resolveCaptureDir } from "../paths.js";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { readUsdCapture, santanderUsdMovementsPayload, stagedUsdCaptureDirs } from "./checkingUsdFeed.js";

const dryRun = process.argv.includes("--dry-run");
const capturesDir = resolveCaptureDir("santander");

const usd = (n: number) => n.toFixed(2);

/** One line per capture with every non-zero outcome. */
export function formatUsdCaptureSummary(name: string, d: UsdAccountMovementsApplyDetails, archivedTo: string | null): string {
  const parts = [`${d.confirmed} confirmed`];
  if (d.awaiting_wire_booking > 0) parts.push(`${d.awaiting_wire_booking} awaiting wire booking`);
  if (d.unexplained > 0) parts.push(`${d.unexplained} UNEXPLAINED`);
  return `${name}: ${d.confirmed + d.awaiting_wire_booking + d.unexplained} row(s) sent, ${parts.join(", ")}${archivedTo ? `; archived ${archivedTo}` : ""}`;
}

async function main(): Promise<number> {
  const dirs = stagedUsdCaptureDirs(capturesDir);
  if (dirs.length === 0) {
    console.log("=== Checking USD movements (no capture staged) ===");
    return 0;
  }
  console.log(`=== Import checking USD movements${dryRun ? " (dry run)" : ""} ===`);
  const config = loadBankConfig("santander");
  if (!config.usd_checking_account_number) {
    log("santander-fetch.json declares no usd_checking_account_number — nothing to decode against");
    return 1;
  }
  const client = dryRun ? null : ingestClient();
  const archiveDir = path.join(capturesDir, "imported");
  const unexplained: string[] = [];
  for (const dir of dirs) {
    const name = path.basename(dir);
    const capture = readUsdCapture(dir);
    const payload = bankAccountMovementsKind.payload.parse(santanderUsdMovementsPayload(capture, config.usd_checking_account_number));
    if (!client) {
      console.log(`  ${name}: ${payload.movements.length} row(s) decoded`);
      for (const m of payload.movements) {
        console.log(`    ${m.date} ${usd(m.amount).padStart(12)} ${m.description}${m.wire_reference ? ` [wire ${m.wire_reference}]` : ""}`);
      }
      continue;
    }
    let details: UsdAccountMovementsApplyDetails;
    try {
      const result = await client.send(bankAccountMovementsKind, payload, {
        channel: "file",
        ref: name,
        label: name,
        ...(capture.fetchedAt ? { fetched_at: capture.fetchedAt } : {}),
      });
      details = result.details as UsdAccountMovementsApplyDetails;
    } catch (err) {
      log(`FAILED ${name}: ${describeIngestFailure(err)}`);
      return 1;
    }
    const archivedTo = path.join(ensureDir(archiveDir), name);
    if (fs.existsSync(archivedTo)) fs.rmSync(archivedTo, { recursive: true, force: true });
    fs.renameSync(dir, archivedTo);
    console.log(`  ${formatUsdCaptureSummary(name, details, archivedTo)}`);
    for (const f of details.awaiting_flows) {
      console.log(`    awaiting wire booking: ${f.occurred_on} ${usd(f.amount)} ${f.description}`);
    }
    for (const f of details.unexplained_flows) {
      unexplained.push(`${name}: ${f.occurred_on} ${usd(f.amount)} ${f.description}`);
    }
  }
  if (unexplained.length > 0) {
    console.error(`USD rows no ledger movement explains — enter them by hand (a card payment: cc:manual-payment; a conversion: a transfer):`);
    console.error(unexplained.map((l) => `  ${l}`).join("\n"));
    return 1;
  }
  return 0;
}

process.exitCode = await main();
