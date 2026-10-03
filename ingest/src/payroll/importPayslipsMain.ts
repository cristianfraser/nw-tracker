/**
 * Send every payslip `parse:payroll-liquidaciones` read to the server as one
 * `employment.payslips`; the server stores them and pairs each with the deposit that paid it.
 *
 *   npm run import:payroll-liquidaciones                        # store + pair
 *   npm run import:payroll-liquidaciones -- --dry-run           # report what would change, write nothing
 *   npm run import:payroll-liquidaciones -- --no-strict         # exit 0 even with unpaired payslips
 *
 * Exit status: non-zero when the server refuses the import or is not reachable, and (unless
 * --no-strict) when a payslip has no deposit, or several.
 */
import path from "node:path";
import { employmentPayslipsKind, type EmploymentPayslipsApplyDetails } from "nw-tracker-contracts";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { payrollParseIndexPath, payslipsPayload, readPayrollParseIndex } from "./payslips.js";

const dryRun = process.argv.includes("--dry-run");
const strict = !process.argv.includes("--no-strict");

async function main(): Promise<number> {
  const file = payrollParseIndexPath();
  const index = readPayrollParseIndex(file);
  let d: EmploymentPayslipsApplyDetails;
  try {
    const result = await ingestClient().send(employmentPayslipsKind, payslipsPayload(index, !dryRun), {
      channel: "file",
      ref: path.basename(file),
    });
    d = result.details as EmploymentPayslipsApplyDetails;
  } catch (err) {
    console.error(`FAILED — ${describeIngestFailure(err)}`);
    return 1;
  }
  for (const c of d.changes) console.log(`  ${c}`);
  if (dryRun) console.log(`# dry-run: ${d.changes.length} of ${d.payslips} payslip(s) would change`);
  for (const l of d.links) console.log(`  linked ${l.document} → movement ${l.movement_id}`);
  for (const a of d.ambiguous) console.error(`  AMBIGUOUS ${a.document}: movement ids ${a.movement_ids.join(", ")}`);
  for (const u of d.unmatched) console.warn(`  unmatched ${u.document} liquido=${u.net_pay} period=${u.period_month}`);
  console.log(
    `\n=== payroll import ===\nrows=${d.payslips} linked=${d.linked} unmatched=${d.unmatched.length} ambiguous=${d.ambiguous.length}${dryRun ? " (dry-run)" : ""}`
  );
  return strict && !dryRun && (d.unmatched.length > 0 || d.ambiguous.length > 0) ? 1 : 0;
}

process.exitCode = await main();
