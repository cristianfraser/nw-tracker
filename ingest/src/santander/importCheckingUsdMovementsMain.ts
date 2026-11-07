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
import path from "node:path";
import { bankAccountMovementsKind, type UsdAccountMovementsApplyDetails } from "nw-tracker-contracts";
import { loadBankConfig } from "../config.js";
import { log } from "../log.js";
import { resolveCaptureDir } from "../paths.js";
import { ingestClient } from "../serverApi.js";
import { sendStaged } from "../stagedFiles.js";
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
  const archiveDir = path.join(capturesDir, "imported");
  const unexplained: string[] = [];
  const docs = dirs.map((dir) => {
    const capture = readUsdCapture(dir);
    return {
      dir,
      name: path.basename(dir),
      capture,
      payload: bankAccountMovementsKind.payload.parse(santanderUsdMovementsPayload(capture, config.usd_checking_account_number!)),
    };
  });
  if (dryRun) {
    for (const d of docs) {
      console.log(`  ${d.name}: ${d.payload.movements.length} row(s) decoded`);
      for (const m of d.payload.movements) {
        console.log(`    ${m.date} ${usd(m.amount).padStart(12)} ${m.description}${m.wire_reference ? ` [wire ${m.wire_reference}]` : ""}`);
      }
    }
    return 0;
  }
  const client = ingestClient();
  const { exitCode } = await sendStaged(docs, {
    path: (d) => d.dir,
    send: (d) =>
      client.send(bankAccountMovementsKind, d.payload, {
        channel: "file",
        ref: d.name,
        label: d.name,
        ...(d.capture.fetchedAt ? { fetched_at: d.capture.fetchedAt } : {}),
      }),
    archive: (d) => ({ dir: archiveDir, name: d.name }),
    report(d, result, archivedTo) {
      const details = result.details as UsdAccountMovementsApplyDetails;
      console.log(`  ${formatUsdCaptureSummary(d.name, details, archivedTo)}`);
      for (const f of details.awaiting_flows) console.log(`    awaiting wire booking: ${f.occurred_on} ${usd(f.amount)} ${f.description}`);
      for (const f of details.unexplained_flows) unexplained.push(`${d.name}: ${f.occurred_on} ${usd(f.amount)} ${f.description}`);
    },
  });
  if (exitCode !== 0) return exitCode;
  if (unexplained.length > 0) {
    console.error(`USD rows no ledger movement explains — enter them by hand (a card payment: cc:manual-payment; a conversion: a transfer):`);
    console.error(unexplained.map((l) => `  ${l}`).join("\n"));
    return 1;
  }
  return 0;
}

process.exitCode = await main();
