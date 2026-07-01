/**
 * Propose synthetic **cuenta_corriente outflow** mirrors for net-worth deposits whose month has no
 * cuenta_corriente cartola data (the `unlinked_no_checking_source` rows on the deposits
 * reconciliation view). Each proposed mirror is a synthetic checking-side *gasto* (money leaving
 * cuenta_corriente to fund the deposit), `deposits` category (excluded from gastos totals), linked
 * with `link_source: 'synthetic'` so the reconciliation page flags it as fabricated, not real data.
 *
 * Scope (what gets a mirror):
 *   - Deposits into cuenta_vista or investment accounts (mega caca, etc.) in a month BEFORE the last
 *     imported cuenta_corriente cartola month — these are real, historical, and the cuenta_corriente
 *     side that funded them is genuinely missing.
 * Explicitly NOT auto-mirrored (shown in separate sections):
 *   - Trailing gaps (months after the last imported cuenta_corriente cartola) — cartola not yet
 *     published; it will arrive. Don't fabricate.
 *   - Deposits into cuenta_corriente itself — can't mirror a cuenta_corriente inflow with a
 *     cuenta_corriente outflow.
 *   - Deposits into cuenta_ahorro_vivienda — only monthly aggregates exist and many were funded by
 *     family (no outflow from own accounts). Needs per-row split/family review, not a blanket mirror.
 *
 *   npm run propose:synthetic-deposit-mirrors -w nw-tracker-server
 *   npm run propose:synthetic-deposit-mirrors -w nw-tracker-server -- --apply
 */
import { db } from "../src/db.js";
import { accountKindSlugForAccountId } from "../src/accountBucket.js";
import { buildDepositsReconciliationPayload, type DepositReconciliationRow } from "../src/flowsDepositsReconciliation.js";
import { buildFlowsCreditCardExpensesPayload } from "../src/flowsCreditCardExpenses.js";
import { getCheckingCartolaMonths } from "../src/checkingCartolaMonthSummary.js";
import { ymCompare } from "../src/calendarMonth.js";

const AHORRO_KIND_SLUG = "cuenta_ahorro_vivienda";

function formatClp(n: number): string {
  return Math.round(n).toLocaleString("es-CL");
}

function findCuentaCorrienteAccountId(): number {
  const row = db
    .prepare(
      `SELECT a.id FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE g.slug LIKE '%cuenta_corriente%'
       ORDER BY a.id LIMIT 1`
    )
    .get() as { id: number } | undefined;
  if (!row) throw new Error("no cuenta_corriente account found");
  return row.id;
}

/** Last month with real cuenta_corriente cartola data; gaps after this are trailing/unpublished. */
function lastImportedCuentaCorrienteMonth(accountId: number): string | null {
  const resp = getCheckingCartolaMonths(accountId);
  if (!resp || resp.imported_months.length === 0) return null;
  return [...resp.imported_months].sort(ymCompare)[resp.imported_months.length - 1]!;
}

// The reconciliation payload already excludes the checking bucket (cuenta_corriente + cuenta_vista)
// from deposit targets, so candidate rows are only non-checking net-worth destinations. The ahorro
// account needs per-deposit self/family split review (see propose-cuenta-ahorro-splits), so it is
// shown separately; everything else with a genuinely missing cartola month gets a mirror.
type Bucket = "mirror" | "ahorro" | "trailing";

function classify(row: DepositReconciliationRow, lastImported: string | null): Bucket {
  const month = row.occurred_on.slice(0, 7);
  if (lastImported != null && ymCompare(month, lastImported) > 0) return "trailing";
  const kind = accountKindSlugForAccountId(row.account_id);
  if (kind === AHORRO_KIND_SLUG) return "ahorro";
  return "mirror";
}

function printMirrorSection(rows: DepositReconciliationRow[]) {
  console.log(`\n${"=".repeat(84)}`);
  console.log(
    `PROPOSED cuenta_corriente synthetic mirror outflows: ${rows.length} | Total CLP: ${formatClp(
      rows.reduce((s, r) => s + r.amount_clp, 0)
    )}`
  );
  console.log("Each row: a real deposit INTO a net-worth account → a synthetic cuenta_corriente OUTFLOW funding it.");
  console.log("=".repeat(84));
  console.log(
    `${"date".padEnd(12)} ${"deposit into".padEnd(34)} ${"deposit (+)".padStart(13)}   ${"cc mirror outflow".padStart(18)}`
  );
  for (const r of rows) {
    console.log(
      `${r.occurred_on.padEnd(12)} ${r.account_name.slice(0, 34).padEnd(34)} ${("+" + formatClp(r.amount_clp)).padStart(13)}   ${("−" + formatClp(r.amount_clp)).padStart(18)}`
    );
  }
}

function printInfoSection(title: string, rows: DepositReconciliationRow[]) {
  if (rows.length === 0) return;
  console.log(`\n${"-".repeat(84)}`);
  console.log(`${title}: ${rows.length} | Total CLP: ${formatClp(rows.reduce((s, r) => s + r.amount_clp, 0))}`);
  console.log("-".repeat(84));
  console.log(`${"date".padEnd(12)} ${"deposit into".padEnd(34)} ${"deposit (+)".padStart(13)}`);
  for (const r of rows) {
    console.log(
      `${r.occurred_on.padEnd(12)} ${r.account_name.slice(0, 34).padEnd(34)} ${("+" + formatClp(r.amount_clp)).padStart(13)}`
    );
  }
}

function applyMirrors(
  accountId: number,
  rows: DepositReconciliationRow[]
): { inserted: number; skipped: number } {
  const exists = db.prepare(`SELECT 1 FROM checking_gap_deposit_mirrors WHERE deposit_movement_id = ?`);
  const ins = db.prepare(
    `INSERT INTO checking_gap_deposit_mirrors (account_id, deposit_movement_id, amount_clp, occurred_on, note)
     VALUES (?, ?, ?, ?, ?)`
  );
  let inserted = 0;
  let skipped = 0;
  for (const row of rows) {
    if (exists.get(row.movement_id)) {
      skipped += 1;
      continue;
    }
    ins.run(
      accountId,
      row.movement_id,
      Math.round(row.amount_clp),
      row.occurred_on,
      `propose-synthetic-deposit-mirrors|source:${row.account_name}|category:${row.category}`
    );
    inserted += 1;
  }
  return { inserted, skipped };
}

function main() {
  const apply = process.argv.includes("--apply");

  const cuentaCorrienteId = findCuentaCorrienteAccountId();
  const lastImported = lastImportedCuentaCorrienteMonth(cuentaCorrienteId);
  console.log(`Mirror target: cuenta_corriente (account ${cuentaCorrienteId}). Last imported cartola month: ${lastImported ?? "—"}.`);

  const payload = buildDepositsReconciliationPayload();
  const candidates = payload.rows.filter((r) => r.status === "unlinked_no_checking_source");

  const byBucket: Record<Bucket, DepositReconciliationRow[]> = { mirror: [], ahorro: [], trailing: [] };
  for (const r of candidates) byBucket[classify(r, lastImported)].push(r);

  printMirrorSection(byBucket.mirror);
  printInfoSection("NOT auto-mirrored — Cuenta de ahorro vivienda (aggregate / family deposits — needs split review)", byBucket.ahorro);
  printInfoSection("SKIPPED — trailing months (cuenta_corriente cartola not yet published)", byBucket.trailing);

  if (byBucket.mirror.length === 0) {
    console.log("\nNothing to mirror.");
    return;
  }

  if (apply) {
    const { inserted, skipped } = applyMirrors(cuentaCorrienteId, byBucket.mirror);
    console.log(`\nApply: inserted=${inserted}, skipped_existing=${skipped}`);
    buildFlowsCreditCardExpensesPayload();
    console.log("Done. Synthetic mirrors inserted and linked.");
  } else {
    console.log("\nDone. No database changes were made. Pass --apply to insert the proposed mirror outflows.");
  }
}

main();
