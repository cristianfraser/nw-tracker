/**
 * What the staged broker e-mails say, before anything is sent.
 *
 *   npm run check:broker-emails -w nw-tracker-ingest
 *
 * A report only, always exit 0. Whether the Racional browser must open is the server's call
 * (it holds the ledger and the crawl state); `import:racional-emails` writes that decision.
 */
import { readStagedBrokerEmails } from "./stagedScans.js";

const { files, scan } = readStagedBrokerEmails();
if (files.length === 0) {
  console.log("No staged broker e-mail scans. Run: npm run fetch:emails");
  process.exit(0);
}
console.log(`${scan.events.length} broker e-mail(s) across ${files.length} scan file(s)\n`);
for (const e of scan.transactions) {
  const money =
    e.amount != null
      ? `${e.amount} ${e.currency ?? ""}`.trim()
      : e.gross_amount != null
        ? `${e.gross_amount} ${e.currency ?? ""} gross`.trim()
        : "(no amount)";
  const units = e.units ? ` · ${e.units} units` : "";
  console.log(
    `  ${e.occurred_at.slice(0, 10)}  ${String(e.broker).padEnd(9)} ${e.kind.padEnd(16)} ${money.padStart(16)}${units}  ` +
      (e.is_complete ? "[complete]" : "[states no amount — a nudge]")
  );
}
const skipped = scan.events.length - scan.transactions.length - scan.unrecognised.length;
console.log(`\n${scan.transactions.length} money notification(s), ${skipped} non-money message(s) ignored.`);
if (scan.unrecognised.length > 0) {
  // Usually marketing — but a NEW transactional template lands here too, and that is how a
  // movement would go missing silently.
  console.log(`\nUnrecognised broker mail (${scan.unrecognised.length}) — check none is a new movement type:`);
  for (const e of scan.unrecognised) {
    console.log(`  ${e.occurred_at.slice(0, 10)}  ${e.broker}  ${e.subject.slice(0, 80)}`);
  }
}
