import {
  buildDealsy2020Q1RowsFromDb,
  upsertSyntheticPayrollRow,
} from "../src/seedPayrollDealsyDb.js";

function argFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function main(): void {
  const dryRun = argFlag("dry-run");
  const rows = buildDealsy2020Q1RowsFromDb();

  for (const row of rows) {
    console.log(
      `  ${row.period_month} liquido=${row.liquido_clp} movement=${row.movement_id} ` +
        `haberes=${row.total_haberes_clp} afp=${row.desc_afp_clp} tax=${row.desc_tax_clp}`
    );
    if (!dryRun) upsertSyntheticPayrollRow(row);
  }

  console.log(
    `\n=== seed payroll dealsy 2020 Q1 ===\nrows=${rows.length}${dryRun ? " (dry-run)" : ""}`
  );
}

main();
