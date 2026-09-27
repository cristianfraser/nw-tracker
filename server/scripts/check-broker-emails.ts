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
 * e-mail itself does not describe — and only until a crawl that ran after that mail has been
 * imported with nothing left to fix (`clean_crawl_at` in `cfraser/.racional-import-state.json`,
 * written by `import:racional-movements -- --apply`). The scans are all re-read every run, so
 * without that one staged dividend mail asked for a crawl every night.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";
import { scanBrokerEmails, type BrokerEmailInput } from "../src/brokerEmailParse.js";
import { racionalComisionCrawlDue, readRacionalImportState } from "../src/racionalMovementsImport.js";

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

const racionalCleanCrawlAt = readRacionalImportState()?.clean_crawl_at ?? null;
const scan = scanBrokerEmails(inputs, { racional: racionalCleanCrawlAt });
const answered = new Set(scan.answered);
console.log(`${inputs.length} broker e-mail(s) across ${files.length} scan file(s)\n`);

for (const event of scan.events) {
  if (!event.is_transaction) continue;
  const money =
    event.amount != null
      ? `${event.amount} ${event.currency ?? ""}`.trim()
      : event.gross_amount != null
        ? `${event.gross_amount} ${event.currency ?? ""} gross`.trim()
        : "(no amount)";
  const units = event.units ? ` · ${event.units} units` : "";
  const status = event.is_complete
    ? "[complete]"
    : answered.has(event)
      ? `[nudge — answered by the crawl of ${racionalCleanCrawlAt}]`
      : "[NUDGE — needs fetch]";
  console.log(
    `  ${event.occurred_at.slice(0, 10)}  ${String(event.broker).padEnd(9)} ${event.kind.padEnd(16)} ` +
      `${money.padStart(16)}${units}  ${status}`
  );
}

const skipped = scan.events.filter((e) => !e.is_transaction).length;
console.log(
  `\n${scan.importable.length} importable from e-mail, ${scan.nudges.length} nudge(s) ` +
    `(${scan.answered.length} already answered by a crawl), ${skipped} non-transaction message(s) ignored.`
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

// Racional's monthly portafolio comisión sends NO e-mail — the only mail-less movement — so
// its nudge is calendar+ledger driven instead of scan driven.
const comision = racionalComisionCrawlDue();
if (comision.due) {
  console.log(`\nCalendar nudge: ${comision.reason} — racional needs a crawl.`);
}
const needsFetch = [...new Set([...scan.needsFetch, ...(comision.due ? ["racional"] : [])])];

const decisionPath = path.join(resolveCfraserCsvDir(), ".broker-email-decision.json");
fs.writeFileSync(
  decisionPath,
  `${JSON.stringify(
    {
      needs_fetch: needsFetch,
      importable: scan.importable.length,
      nudges: scan.nudges.length,
      answered_nudges: scan.answered.length,
      scanned_files: files.map((f) => path.basename(f)),
      decided_at: new Date().toISOString(),
    },
    null,
    2
  )}\n`
);

console.log(
  needsFetch.length === 0
    ? "Nothing needs a browser fetch."
    : `Needs a browser fetch: ${needsFetch.join(", ")}`
);
console.log(`decision → ${decisionPath}`);
