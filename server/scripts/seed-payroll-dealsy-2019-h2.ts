import {
  buildDealsy2019H2RowsFromDb,
  upsertSyntheticPayrollRow,
} from "../src/seedPayrollDealsyDb.js";

function argFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function main(): void {
  const dryRun = argFlag("dry-run");
  const rows = buildDealsy2019H2RowsFromDb();

  for (const row of rows) {
    console.log(
      `  ${row.period_month} liquido=${row.liquido_clp} movement=${row.movement_id} ` +
        `afp=${row.desc_afp_clp} health=${row.desc_health_clp} tax=${row.desc_tax_clp}`
    );
    if (!dryRun) upsertSyntheticPayrollRow(row);
  }

  console.log(
    `\n=== seed payroll dealsy 2019 H2 ===\nrows=${rows.length}${dryRun ? " (dry-run)" : ""}`
  );
}

main();
