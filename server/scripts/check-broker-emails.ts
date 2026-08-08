/**
 * Classify the broker e-mails staged by `npm run fetch:emails` and say what needs fetching.
 *
 *   npm run check:broker-emails -w nw-tracker-server
 *
 * Writes its decision to `cfraser/.broker-email-decision.json` and exits 0 — deliberately NOT
 * a non-zero "needs fetch" code, which the daily runner would count as a failed step and
 * report as an alert. A decision is not a failure.
 *
 * Splitting it this way is the point of the design: reading mail is free, opening a bank
 * session is not, so the browser only runs when a notification proves there is activity the
 * e-mail itself does not describe.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";
import { scanBrokerEmails, type BrokerEmailInput } from "../src/brokerEmailParse.js";

const dir = path.join(resolveCfraserCsvDir(), "broker-emails");
const files = fs.existsSync(dir)
  ? fs
      .readdirSync(dir)
      .filter((n) => /^scan-.*\.json$/.test(n))
      .sort()
      .map((n) => path.join(dir, n))
  : [];

if (files.length === 0) {
  console.log(`No staged broker e-mail scans in ${dir}. Run: npm run fetch:emails`);
  process.exit(0);
}

const inputs: BrokerEmailInput[] = [];
for (const file of files) {
  const rows = JSON.parse(fs.readFileSync(file, "utf8")) as BrokerEmailInput[];
  inputs.push(...rows);
}

const scan = scanBrokerEmails(inputs);
console.log(`${inputs.length} broker e-mail(s) across ${files.length} scan file(s)\n`);

for (const event of scan.events) {
  if (!event.is_transaction) continue;
  const money =
    event.amount != null ? `${event.amount} ${event.currency ?? ""}`.trim() : "(no amount)";
  const units = event.units ? ` · ${event.units} units` : "";
  console.log(
    `  ${event.occurred_at.slice(0, 10)}  ${String(event.broker).padEnd(9)} ${event.kind.padEnd(16)} ` +
      `${money.padStart(16)}${units}  ${event.is_complete ? "[complete]" : "[NUDGE — needs fetch]"}`
  );
}

const skipped = scan.events.filter((e) => !e.is_transaction).length;
console.log(
  `\n${scan.importable.length} importable from e-mail, ${scan.nudges.length} nudge(s), ${skipped} non-transaction message(s) ignored.`
);

if (scan.unrecognised.length > 0) {
  // Usually marketing — but a NEW transactional template lands here too, and that is how a
  // movement would go missing silently.
  console.log(`\nUnrecognised broker mail (${scan.unrecognised.length}) — check none is a new movement type:`);
  for (const e of scan.unrecognised) {
    console.log(`  ${e.occurred_at.slice(0, 10)}  ${e.broker}  ${e.subject.slice(0, 80)}`);
  }
}

if (scan.unresolved.length > 0) {
  // No fetcher exists for these, so they are for a human, not for the runner.
  console.log("\nIncomplete and not fetchable — review by hand:");
  for (const e of scan.unresolved) {
    console.log(`  ${e.occurred_at.slice(0, 10)}  ${e.broker}  ${e.kind}  ${e.subject}`);
  }
}

const decisionPath = path.join(resolveCfraserCsvDir(), ".broker-email-decision.json");
fs.writeFileSync(
  decisionPath,
  `${JSON.stringify(
    {
      needs_fetch: scan.needsFetch,
      importable: scan.importable.length,
      nudges: scan.nudges.length,
      scanned_files: files.map((f) => path.basename(f)),
      decided_at: new Date().toISOString(),
    },
    null,
    2
  )}\n`
);

console.log(
  scan.needsFetch.length === 0
    ? "Nothing needs a browser fetch."
    : `Needs a browser fetch: ${scan.needsFetch.join(", ")}`
);
console.log(`decision → ${decisionPath}`);
