import {
  buildDeel2021H1Rows,
  DEEL_2021_EXCLUDED_CHECKING_INCOME_MOVEMENT_IDS,
} from "../src/seedPayrollDeelUsdSynthetic.js";
import {
  excludeDeelFxCheckingIncomeMovement,
  upsertSyntheticDeelUsdPayrollRow,
} from "../src/seedPayrollDeelDb.js";

function argFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function main(): void {
  const dryRun = argFlag("dry-run");
  const payroll_rows = buildDeel2021H1Rows();

  for (const row of payroll_rows) {
    console.log(
      `  ${row.period_month} liquido_usd=${row.liquido_usd} liquido_clp=${row.liquido_clp} ` +
        `wire=${row.wire_received_on}`
    );
    if (!dryRun) upsertSyntheticDeelUsdPayrollRow(row);
  }

  console.log(`  excluded checking movements: ${DEEL_2021_EXCLUDED_CHECKING_INCOME_MOVEMENT_IDS.join(", ")}`);
  if (!dryRun) {
    for (const movementId of DEEL_2021_EXCLUDED_CHECKING_INCOME_MOVEMENT_IDS) {
      excludeDeelFxCheckingIncomeMovement(movementId);
    }
  }

  console.log(
    `\n=== seed payroll Deel USD 2021-01..08 ===\nrows=${payroll_rows.length}${dryRun ? " (dry-run)" : ""}`
  );
}

main();
