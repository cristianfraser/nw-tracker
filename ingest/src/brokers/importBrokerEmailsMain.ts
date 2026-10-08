/**
 * Send one broker's money notifications to the server (`broker.notifications`).
 *
 *   npm run import:fintual-emails -w nw-tracker-ingest              # report only
 *   npm run import:fintual-emails -w nw-tracker-ingest -- --apply   # write
 *   npm run import:racional-emails -w nw-tracker-ingest [-- --apply]
 *
 * Every money mail the broker sent that is still staged goes, each run: the server books what is
 * complete and not yet in the ledger, so re-sending is idempotent and a mail that could not be
 * booked yet is retried by being sent again.
 *
 * Fintual: exits 1 while the server reports a retiro synthesized from a mail whose bank credit
 * never appeared — the wire never arrived, and a phantom credit would be absorbed silently into
 * the next checking-anchor derivation. The failed step is what badges a notification.
 *
 * Racional: writes the server's crawl decision to `cfraser/.broker-email-decision.json`
 * (`needs_fetch`), which the runner reads before opening the Racional browser.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { brokerNotificationsKind, type BrokerNotificationsApplyDetails } from "nw-tracker-contracts";
import { resolveCfraserDir } from "../paths.js";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { brokerNotificationsFromScan } from "./brokerEmail.js";
import { readStagedBrokerEmails } from "./stagedScans.js";
import { logWireBookings } from "../wires/incomingWiresStep.js";

const brokerArg = /^--broker=(fintual|racional)$/.exec(process.argv.find((a) => a.startsWith("--broker=")) ?? "");
if (!brokerArg) throw new Error("usage: importBrokerEmailsMain.ts --broker=fintual|racional [--apply]");
const broker = brokerArg[1] as "fintual" | "racional";
const apply = process.argv.includes("--apply");

function decisionPath(): string {
  return path.join(resolveCfraserDir(), ".broker-email-decision.json");
}

async function main(): Promise<number> {
  const { files, scan } = readStagedBrokerEmails();
  const notifications = brokerNotificationsFromScan(scan, broker);
  const payload = brokerNotificationsKind.payload.parse({ broker, apply, notifications });
  // A stale decision must never open the browser: it is rewritten from this run's answer only.
  if (broker === "racional") fs.rmSync(decisionPath(), { force: true });

  let details: BrokerNotificationsApplyDetails;
  try {
    const ids = notifications.map((n) => n.message_id).sort().join("\n");
    const result = await ingestClient().send(brokerNotificationsKind, payload, {
      channel: "email",
      ref: `${broker}-notifications|${crypto.createHash("sha256").update(ids).digest("hex")}`,
      label: `${notifications.length} ${broker} notification(s) from ${files.length} scan file(s)`,
    });
    details = result.details as BrokerNotificationsApplyDetails;
  } catch (err) {
    console.error(`FAILED: ${describeIngestFailure(err)}`);
    return 1;
  }

  for (const r of details.planned) {
    const units = r.units ? ` · ${r.units} units` : "";
    console.log(
      `  ${r.occurred_on}  ${r.kind.padEnd(16)} ${String(r.amount).padStart(12)} ${r.currency}  ${r.legs ?? "(no legs)"}${units}  ` +
        `[${r.state}]${r.detail ? ` ${r.detail}` : ""}`
    );
  }
  if (details.planned.length === 0) console.log(`No ${broker} movements in the staged e-mail.`);
  const writable = details.planned.filter((r) => r.state !== "duplicate" && r.state !== "manual").length;
  console.log(apply ? `\nImported ${details.written} movement(s).` : `\nReport only — ${writable} would be written. Re-run with --apply.`);

  if (details.incomplete.length > 0) {
    console.log("\nStates no amount and nothing fetches it — review by hand:");
    for (const n of details.incomplete) console.log(`  ${n.occurred_at.slice(0, 10)}  ${n.kind}  ${n.subject}`);
  }

  if (details.fetch) {
    const f = details.fetch;
    console.log(
      `\n${f.nudges} notification(s) the crawl describes (${f.answered} already answered). ` +
        (f.needed ? `Needs a browser fetch:\n${f.reasons.map((r) => `  ${r}`).join("\n")}` : "Nothing needs a browser fetch.")
    );
    fs.writeFileSync(
      decisionPath(),
      `${JSON.stringify(
        {
          needs_fetch: f.needed ? ["racional"] : [],
          reasons: f.reasons,
          nudges: f.nudges,
          answered_nudges: f.answered,
          scanned_files: files.map((file) => path.basename(file)),
          decided_at: new Date().toISOString(),
        },
        null,
        2
      )}\n`
    );
  }

  for (const o of details.overdue_synthetic_retiros) {
    console.error(
      `⚠ synthesized retiro movement ${o.movement_id} (paid ${o.paid_on}, $${o.amount_clp}) has no bank ` +
        `listing by ${o.deadline ?? o.paid_on} — the wire its mail promised never appeared in any bank ` +
        `feed; verify the checking credit and delete the transfer if the money never arrived`
    );
  }
  // Dollar withdrawals Fintual confirmed, and the wires that paid them (`bank_account.incoming_wires`).
  const overdueWithdrawal = details.usd_withdrawals ? logWireBookings(details.usd_withdrawals, details.applied) : false;
  return details.overdue_synthetic_retiros.length > 0 || overdueWithdrawal ? 1 : 0;
}

process.exitCode = await main();
