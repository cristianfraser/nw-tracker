/**
 * Send every card statement `parse:cc-pdfs` read (`cfraser/cc-statements-parsed-all.csv`) to the
 * server as one `card.statement` of canonical statements (converted here, once). The server imports
 * the statements whose content changed since their last import.
 *
 *   npm run import:cc-statements -w nw-tracker-ingest                 # import the changed statements
 *   npm run import:cc-statements -w nw-tracker-ingest -- --dry-run    # report only
 *   npm run import:cc-statements -w nw-tracker-ingest -- --full       # re-import every statement
 *   npm run import:cc-statements -w nw-tracker-ingest -- --csv=<path>
 *
 * Exit status: non-zero when the server refuses the import (a reconcile gate, a line no card
 * account takes) or is not reachable; the server's reasons go to the run step's problems.
 * Statements imported with lines no printed figure verified are listed in the report
 * («imported unverified»).
 */
import path from "node:path";
import { cardStatementKind, type CardParsedStatementsApplyDetails } from "nw-tracker-contracts";
import { resolveCfraserDir } from "../paths.js";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { reportStepResult } from "../stepResult.js";
import { canonicalStatementsPayload, readParsedStatementsCsv } from "./parsedStatements.js";

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
  const payload = canonicalStatementsPayload(csv, { full });
  let details: CardParsedStatementsApplyDetails;
  try {
    const result = await ingestClient().send(cardStatementKind, payload, {
      channel: "file",
      ref: path.basename(file),
    }, { dryRun });
    details = result.details as CardParsedStatementsApplyDetails;
  } catch (err) {
    const failure = describeIngestFailure(err);
    console.error(`FAILED — ${failure}`);
    // A refused statement says what is wrong one fact per line (the statement, each figure, the
    // rows printed twice): each line is a problem the run message lists under the step.
    reportStepResult({ problems: failure.split("\n").filter((l) => l.trim()) });
    return 1;
  }
  console.log(`# ${csv.rows.length} parsed line(s) from ${path.basename(file)}${full ? " (full re-import)" : ""}${dryRun ? " — dry run" : ""}`);
  for (const line of details.report) console.log(line);
  for (const problem of details.problems) console.error(`# FAIL: ${problem}`);
  if (details.problems.length > 0) reportStepResult({ problems: details.problems });
  return details.problems.length > 0 ? 1 : 0;
}

process.exitCode = await main();
