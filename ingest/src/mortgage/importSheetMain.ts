/**
 * The mortgage sheet → the depto ledger (`mortgage.sheet_payments`).
 *
 *   npm run import:mortgage-sheet [-- --dry-run | --offline]
 *
 * Reads the table named in `cfraser/mortgage-sheet.json` straight out of the Numbers file and
 * sends every pie / prepago row and every posted cuota. The server cross-checks what it already
 * holds (a difference is a conflict: nothing written, exit 1), writes the posted cuotas it lacks,
 * and answers `duplicate` for a file it applied before. `--dry-run` sends with `apply: false`
 * (the server reports and rolls back); `--offline` only reads and prints the rows.
 */
import { mortgageSheetPaymentsKind, type MortgageSheetPaymentsApplyDetails } from "nw-tracker-contracts";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { loadMortgageSheetConfig, mortgageSheetPayload, readMortgageSheet } from "./sheet.js";

const dryRun = process.argv.includes("--dry-run");
const offline = process.argv.includes("--offline");

function printDetails(d: MortgageSheetPaymentsApplyDetails): void {
  for (const r of d.rows) {
    const filled = r.filled.length ? ` (filled ${r.filled.join(", ")})` : "";
    const mov = r.mortgage_movement_id != null ? ` → movement ${r.mortgage_movement_id}` : "";
    console.log(`  ${r.status.padEnd(8)} ${r.label.padEnd(10)} ${r.paid_on}${filled}${mov}`);
  }
  for (const x of d.accepted) console.log(`  accepted row ${x.label}: ${x.field} sheet ${x.sheet} ≠ ledger ${x.ledger} — ${x.reason}`);
  for (const x of d.drift) console.error(`  ⚠ row ${x.label}: ${x.field} sheet ${x.sheet} ≠ ledger ${x.ledger}`);
  if (d.projected.length) console.log(`  projected (left out): ${d.projected.length} cuota(s) from ${d.projected[0]}`);
}

async function main(): Promise<number> {
  const cfg = loadMortgageSheetConfig();
  if (!cfg) {
    console.log("=== Mortgage sheet (no cfraser/mortgage-sheet.json — not configured) ===");
    return 0;
  }
  console.log(`=== Mortgage sheet${dryRun ? " (dry run)" : offline ? " (offline)" : ""} ===`);
  const read = readMortgageSheet(cfg);
  const payload = mortgageSheetPayload(read, !dryRun, cfg.accepted_differences);
  console.log(`${read.document.name}: ${payload.rows.length} row(s), ${payload.projected.length} projected; sha256 ${payload.document.sha256.slice(0, 12)}`);
  if (offline) {
    for (const r of payload.rows) console.log(`  ${r.kind.padEnd(7)} ${r.label.padEnd(10)} ${r.paid_on} $${r.pago_clp} ${r.pago_uf} UF`);
    return 0;
  }
  try {
    const result = await ingestClient().send(mortgageSheetPaymentsKind, payload, { channel: "file", ref: payload.document.sha256 });
    const d = result.details as MortgageSheetPaymentsApplyDetails;
    if (result.status === "duplicate") {
      console.log(`unchanged — ${result.message ?? "already applied"}`);
      return 0;
    }
    printDetails(d);
    const written = d.rows.filter((r) => r.status === "written").length;
    if (result.status === "conflict") {
      console.error(`CONFLICT — ${result.message ?? "the sheet and the ledger disagree"}`);
      return 1;
    }
    console.log(`mortgage sheet: ${written} row(s) written${d.applied ? "" : " (reported only)"}, ${d.rows.filter((r) => r.status === "checked").length} checked`);
    return 0;
  } catch (err) {
    console.error(`FAILED — ${describeIngestFailure(err)}`);
    return 1;
  }
}

process.exitCode = await main();
