/**
 * Import credit-card movements fetched by `scraper/` into the ledger.
 *
 *   npm run import:santander-movements -w nw-tracker-server            # import + archive
 *   npm run import:santander-movements -w nw-tracker-server -- --dry-run
 *
 * Report-first by default is deliberate for a path that writes to the real ledger.
 */
import {
  importStagedSantanderMovements,
  listSantanderMovementFiles,
  resolveSantanderMovementsDir,
} from "../src/santanderMovementsImport.js";
import { santanderMovementsByAccount } from "../src/santanderCardMovements.js";
import { masterAccountIdForSantanderAccount } from "../src/santanderAccountMap.js";
import fs from "node:fs";

const dryRun = process.argv.includes("--dry-run");
const dir = resolveSantanderMovementsDir();
const files = listSantanderMovementFiles(dir);

if (files.length === 0) {
  console.log(`No fetched movement files in ${dir}. Run: npm run fetch:santander`);
  process.exit(0);
}

if (dryRun) {
  console.log(`Dry run — ${files.length} file(s) in ${dir}\n`);
  for (const file of files) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    console.log(file.split("/").pop());
    for (const group of santanderMovementsByAccount(parsed)) {
      const accountId = masterAccountIdForSantanderAccount(group.account);
      const byCurrency = group.lines.reduce<Record<string, number>>((acc, line) => {
        acc[line.currency] = (acc[line.currency] ?? 0) + 1;
        return acc;
      }, {});
      console.log(`  account ${group.account} → id ${accountId}: ${group.lines.length} lines`, byCurrency);
    }
  }
  console.log("\nNothing written. Re-run without --dry-run to import.");
  process.exit(0);
}

const fmt = (n: number) => Math.round(n).toLocaleString("es-CL"); // convention-ok: CLI log
const results = importStagedSantanderMovements(dir);
for (const result of results) {
  console.log(result.file);
  for (const account of result.accounts) {
    console.log(
      `  account ${account.account} (id ${account.account_id}): ` +
        `${account.inserted} inserted, ${account.skipped_duplicate} duplicate, ` +
        `batch ${account.batch_id ?? "-"}`
    );
    for (const plan of account.plans_created) {
      console.log(
        `    cuota plan created: ${plan.purchase_date} ${plan.merchant} $${fmt(plan.principal_clp)} ` +
          `in ${plan.cuotas} (${plan.kind}), first cuota ${plan.first_due_month}`
      );
    }
    for (const n of account.first_due_nudges) {
      console.log(`    first cuota of plan ${n.purchase_id} (${n.merchant}) ${n.from ?? "unset"} → ${n.to} [${n.rule}]`);
    }
    if (account.cuota_lines_tagged > 0) {
      console.log(`    ${account.cuota_lines_tagged} cuota purchase line(s) tagged (count unknown until the statement)`);
    }
    for (const r of account.mirror?.removed ?? []) {
      console.log(
        `    no longer listed by the bank, removed: ${r.date} ${r.merchant} ${r.amount_usd ? `US$${r.amount_usd}` : `$${fmt(r.amount_clp ?? 0)}`}`
      );
    }
    const close = account.feed_close;
    if (!close) continue;
    const usd = close.saldo_inicial_usd != null ? ` + US$${close.saldo_inicial_usd.toFixed(2)}` : "";
    console.log(
      `    close ${close.close_iso} (${close.status}): SALDO INICIAL $${fmt(close.saldo_inicial_clp ?? 0)}${usd}; ` +
        `rows filed under ${close.rows_billing_month}` +
        (close.lines_moved_forward > 0 ? `, ${close.lines_moved_forward} line(s) moved forward` : "")
    );
    const check = close.provisional_check;
    if (check) {
      const gap = check.bank_total_clp - check.app_estimate_clp;
      console.log(
        `    provisional ${close.billing_month}: bank $${fmt(check.bank_total_clp)} vs app estimate ` +
          `$${fmt(check.app_estimate_clp)} (${gap >= 0 ? "+" : ""}${fmt(gap)})`
      );
    }
  }
}
console.log(`\nImported ${results.length} file(s); originals moved to ${dir}/imported/`);
