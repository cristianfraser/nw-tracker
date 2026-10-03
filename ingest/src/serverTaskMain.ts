/**
 * Run one of the server's tasks (`POST /api/ingest/tasks/<task>`, `contracts/tasks.ts`) and print
 * its report — the step a run takes after the card feed or the receipts land.
 *
 *   npm run server-task -w nw-tracker-ingest -- cc_payment_mirrors [--dry-run]
 *   npm run server-task -w nw-tracker-ingest -- synthetic_cc_payments_check
 *   npm run server-task -w nw-tracker-ingest -- cc_bank_cupo_check [--recheck]
 *
 * The root scripts `convert:cc-payment-mirrors`, `check:synthetic-cc-payments` and
 * `check:cc-bank-cupo` call it. Exit status: 1 when the task fails or the server refuses or is
 * down, 2 on an unknown task.
 */
import { INGEST_TASK_NAMES, type IngestTaskName } from "nw-tracker-contracts";
import { describeIngestFailure, ingestClient } from "./serverApi.js";

async function main(): Promise<number> {
  const task = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!task || !(INGEST_TASK_NAMES as readonly string[]).includes(task)) {
    console.error(`Usage: server-task <${INGEST_TASK_NAMES.join(" | ")}> [--dry-run] [--recheck]`);
    return 2;
  }
  try {
    const result = await ingestClient().runTask(task as IngestTaskName, {
      dry_run: process.argv.includes("--dry-run"),
      recheck: process.argv.includes("--recheck"),
    });
    for (const line of result.report) (result.ok ? console.log : console.error)(line);
    return result.ok ? 0 : 1;
  } catch (err) {
    console.error(`FAILED — ${describeIngestFailure(err)}`);
    return 1;
  }
}

process.exitCode = await main();
