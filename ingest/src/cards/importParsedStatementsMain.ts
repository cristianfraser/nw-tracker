/**
 * Send every card statement `parse:cc-pdfs` read (`cfraser/cc-statements-parsed-all.csv`) to the
 * server as one `card.parsed_statements`. The server imports the statements whose rows changed
 * since their last import.
 *
 *   npm run import:cc-statements -w nw-tracker-ingest                 # import the changed statements
 *   npm run import:cc-statements -w nw-tracker-ingest -- --dry-run    # report only
 *   npm run import:cc-statements -w nw-tracker-ingest -- --full       # re-import every statement
 *   npm run import:cc-statements -w nw-tracker-ingest -- --csv=<path>
 *
 * Exit status: non-zero when the server refuses the import (a reconcile gate, a line no card
 * account takes) or is not reachable.
 */
import path from "node:path";
import { cardParsedStatementsKind, type CardParsedStatementsApplyDetails } from "nw-tracker-contracts";
import { resolveCfraserDir } from "../paths.js";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { parsedStatementsPayload, readParsedStatementsCsv } from "./parsedStatements.js";

const dryRun = process.argv.includes("--dry-run");
const full = process.argv.includes("--full");
const csvArg = process.argv.find((a) => a.startsWith("--csv="))?.slice("--csv=".length);
const file = csvArg ? path.resolve(csvArg) : path.join(resolveCfraserDir(), "cc-statements-parsed-all.csv");

async function main(): Promise<number> {
  const csv = readParsedStatementsCsv(file);
  if (!csv) {
    console.error(`No parsed statement lines in ${file} — run parse:cc-pdfs first.`);
    return 1;
  }
  const payload = parsedStatementsPayload(csv, { apply: !dryRun, full });
  let details: CardParsedStatementsApplyDetails;
  try {
    const result = await ingestClient().send(cardParsedStatementsKind, payload, {
      channel: "file",
      ref: path.basename(file),
    });
    details = result.details as CardParsedStatementsApplyDetails;
  } catch (err) {
    console.error(`FAILED — ${describeIngestFailure(err)}`);
    return 1;
  }
  console.log(`# ${csv.rows.length} parsed line(s) from ${path.basename(file)}${full ? " (full re-import)" : ""}${dryRun ? " — dry run" : ""}`);
  for (const line of details.report) console.log(line);
  for (const problem of details.problems) console.error(`# FAIL: ${problem}`);
  return details.problems.length > 0 ? 1 : 0;
}

process.exitCode = await main();
