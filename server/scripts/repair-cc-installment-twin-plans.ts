/**
 * Backfill installment plans for same-statement twin purchases (migration 187).
 *
 * Identical purchases made the same day, each in cuotas, print one identical cuota line each on
 * every statement. Before twin plans existed the builder collapsed them into ONE plan: the ledger
 * carried a fraction of the debt and that plan's payment links hopped between the twins' lines.
 * This re-runs the fixed builder over the twin loans' parsed rows only — every other plan is left
 * alone — which adds the missing twins, re-points the first plan's links at its own lines and,
 * from the earliest purchase it adds, re-syncs the card's valuations and billing-month balances
 * (both inside `mergeInstallmentLedgerFromParsedRows`).
 *
 * Report-first: without --apply the whole run happens inside a transaction that is rolled back
 * after the report, so the report IS the post-repair ledger.
 *
 *   npx tsx server/scripts/repair-cc-installment-twin-plans.ts [--account-id=NN] [--csv=/abs.csv] [--apply]
 */
import path from "node:path";

import { invalidateCcBillingDetail } from "../src/aggregationCache.js";
import { ccBilledCuotasIdentity } from "../src/ccBilledCuotasIdentity.js";
import { resolveMasterAccountIdForImportCardLast4 } from "../src/ccConsolidatedCards.js";
import {
  groupInstallmentLoanChains,
  mergeInstallmentLedgerFromParsedRows,
} from "../src/ccInstallmentLedgerMerge.js";
import { parseDdMmYyToIso } from "../src/ccInstallmentPayBy.js";
import { readCommaCsvRecords } from "../src/ccParsedCommaCsv.js";
import { cardLast4FromParsedRow } from "../src/ccParsedImportAccounts.js";
import type { CcStatementCsvRecord } from "../src/ccStatementsImport.js";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";
import { db } from "../src/db.js";

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  return process.argv.find((a) => a.startsWith(p))?.slice(p.length);
}

const fmt = (n: number) => n.toLocaleString("es-CL");

type PlanSnap = {
  id: number;
  twin_index: number;
  canonical_row_id: string;
  purchase_date: string;
  total_amount_clp: number;
  cuotas_totales: number;
  merchant: string | null;
  dedupe_key: string | null;
  parser_row_id_sample: string | null;
  source_pdf_sample: string | null;
};

type PaymentSnap = {
  purchase_id: number;
  pay_by_date: string;
  statement_period_month: string | null;
  amount_clp: number;
  cuota_current: number | null;
  parser_row_id: string | null;
};

type Snapshot = {
  plans: Map<number, PlanSnap>;
  payments: Map<string, PaymentSnap>;
  valuations: Map<string, number>;
  unexplainedByMonth: Map<string, number>;
};

function snapshot(accountId: number): Snapshot {
  const plans = new Map<number, PlanSnap>();
  for (const p of db
    .prepare(
      `SELECT id, twin_index, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales, merchant,
              dedupe_key, parser_row_id_sample, source_pdf_sample
       FROM cc_installment_purchases WHERE account_id = ?`
    )
    .all(accountId) as PlanSnap[]) {
    plans.set(p.id, p);
  }
  const payments = new Map<string, PaymentSnap>();
  for (const pay of db
    .prepare(
      `SELECT pay.purchase_id, pay.pay_by_date, pay.statement_period_month, pay.amount_clp,
              pay.cuota_current, pay.parser_row_id
       FROM cc_installment_payments pay
       JOIN cc_installment_purchases p ON p.id = pay.purchase_id
       WHERE p.account_id = ?`
    )
    .all(accountId) as PaymentSnap[]) {
    payments.set(`${pay.purchase_id}\t${pay.pay_by_date}`, pay);
  }
  const valuations = new Map<string, number>();
  for (const v of db
    .prepare(`SELECT as_of_date, value FROM valuations WHERE account_id = ?`)
    .all(accountId) as { as_of_date: string; value: number }[]) {
    valuations.set(v.as_of_date, v.value);
  }
  invalidateCcBillingDetail(accountId);
  const unexplainedByMonth = new Map(
    ccBilledCuotasIdentity(accountId).map((m) => [m.billing_month, m.unexplained_clp] as const)
  );
  return { plans, payments, valuations, unexplainedByMonth };
}

function describePlan(p: PlanSnap): string {
  return `#${p.id} twin ${p.twin_index}  ${p.purchase_date}  ${fmt(p.total_amount_clp)} × ${p.cuotas_totales}  ${p.merchant ?? ""}`;
}

function reportDiff(before: Snapshot, after: Snapshot): void {
  const statementPayments = (purchaseId: number, snap: Snapshot) =>
    [...snap.payments.values()].filter(
      (pay) => pay.purchase_id === purchaseId && !String(pay.parser_row_id ?? "").startsWith("synthetic:")
    ).length;

  const added = [...after.plans.values()].filter((p) => !before.plans.has(p.id));
  console.log(`  plans added: ${added.length}`);
  for (const p of added) console.log(`    ${describePlan(p)}  — ${statementPayments(p.id, after)} statement payments`);

  const removed = [...before.plans.values()].filter((p) => !after.plans.has(p.id));
  if (removed.length > 0) {
    throw new Error(`the builder removed plans ${removed.map((p) => p.id).join(", ")} — it never deletes; aborting`);
  }
  for (const p of after.plans.values()) {
    const prev = before.plans.get(p.id);
    if (!prev) continue;
    const changed = (Object.keys(p) as (keyof PlanSnap)[]).filter((k) => p[k] !== prev[k]);
    if (changed.length === 0) continue;
    console.log(
      `  plan updated ${describePlan(p)}: ` +
        changed.map((k) => `${k} ${JSON.stringify(prev[k])} → ${JSON.stringify(p[k])}`).join(", ")
    );
  }

  let paymentsAdded = 0;
  for (const [key, pay] of after.payments) {
    const prev = before.payments.get(key);
    if (!prev) {
      paymentsAdded += 1;
      continue;
    }
    const changed = (Object.keys(pay) as (keyof PaymentSnap)[]).filter((k) => pay[k] !== prev[k]);
    if (changed.length === 0) continue;
    console.log(
      `  payment changed plan #${pay.purchase_id} ${pay.pay_by_date}: ` +
        changed.map((k) => `${k} ${JSON.stringify(prev[k])} → ${JSON.stringify(pay[k])}`).join(", ")
    );
  }
  const paymentsRemoved = [...before.payments.keys()].filter((k) => !after.payments.has(k));
  console.log(`  payments added: ${paymentsAdded}, removed: ${paymentsRemoved.length}`);
  for (const key of paymentsRemoved) {
    const pay = before.payments.get(key)!;
    console.log(`    removed plan #${pay.purchase_id} ${pay.pay_by_date} ${pay.parser_row_id ?? ""}`);
  }

  const dates = [...new Set([...before.valuations.keys(), ...after.valuations.keys()])].sort();
  const valuationChanges = dates.filter((d) => before.valuations.get(d) !== after.valuations.get(d));
  console.log(`  valuations changed: ${valuationChanges.length}`);
  for (const d of valuationChanges) {
    const b = before.valuations.get(d);
    const a = after.valuations.get(d);
    const delta = a != null && b != null ? `  (${a - b >= 0 ? "+" : ""}${fmt(a - b)})` : "";
    console.log(`    ${d}  ${b == null ? "—" : fmt(b)} → ${a == null ? "—" : fmt(a)}${delta}`);
  }

  const months = [...new Set([...before.unexplainedByMonth.keys(), ...after.unexplainedByMonth.keys()])].sort();
  const residuals = months.filter(
    (m) => (before.unexplainedByMonth.get(m) ?? 0) !== 0 || (after.unexplainedByMonth.get(m) ?? 0) !== 0
  );
  console.log(`  closed facturaciones whose billed cuotas ≠ cuota a pagar (before → after):`);
  if (residuals.length === 0) console.log("    none");
  for (const m of residuals) {
    console.log(
      `    ${m}  ${fmt(before.unexplainedByMonth.get(m) ?? 0)} → ${fmt(after.unexplainedByMonth.get(m) ?? 0)}`
    );
  }
}

type TwinEvidence = {
  account_id: number;
  merchant: string | null;
  purchase_iso: string;
  amount_clp: number | null;
  nro_cuota_total: number | null;
  twins: number;
  statements: number;
};

/** Installment twins in the stored statement lines (evidence the parsed CSV must cover). */
function statementTwinEvidence(): TwinEvidence[] {
  const rows = db
    .prepare(
      `SELECT s.account_id, l.merchant, l.transaction_date, l.amount_clp, l.nro_cuota_total,
              COUNT(*) AS n
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE l.installment_flag = 1 AND s.source_pdf NOT LIKE 'import:web-paste%'
       GROUP BY s.id, l.merchant, l.transaction_date, l.amount_clp, l.nro_cuota_total, l.nro_cuota_current
       HAVING COUNT(*) > 1`
    )
    .all() as {
    account_id: number;
    merchant: string | null;
    transaction_date: string | null;
    amount_clp: number | null;
    nro_cuota_total: number | null;
    n: number;
  }[];
  // Statements print the purchase date as dd/mm/yyyy or dd/mm/yy — one set either way.
  const sets = new Map<string, TwinEvidence>();
  for (const r of rows) {
    const purchaseIso = parseDdMmYyToIso(String(r.transaction_date ?? "")) ?? String(r.transaction_date);
    const key = [r.account_id, r.merchant, purchaseIso, r.amount_clp, r.nro_cuota_total].join("\t");
    const set = sets.get(key) ?? {
      account_id: r.account_id,
      merchant: r.merchant,
      purchase_iso: purchaseIso,
      amount_clp: r.amount_clp,
      nro_cuota_total: r.nro_cuota_total,
      twins: 0,
      statements: 0,
    };
    set.twins = Math.max(set.twins, r.n);
    set.statements += 1;
    sets.set(key, set);
  }
  return [...sets.values()].sort(
    (a, b) => a.account_id - b.account_id || a.purchase_iso.localeCompare(b.purchase_iso)
  );
}

class ReportOnly extends Error {}

function main(): void {
  const apply = process.argv.includes("--apply");
  const onlyAccount = Number(arg("account-id"));
  const csvPath = arg("csv") ?? path.join(resolveCfraserCsvDir(), "cc-statements-parsed-all.csv");

  const evidence = statementTwinEvidence();
  console.log(`# installment twins in stored statement lines: ${evidence.length} set(s)`);
  for (const e of evidence) {
    console.log(
      `  account ${e.account_id}  ${e.purchase_iso}  ${fmt(e.amount_clp ?? 0)} × ${e.nro_cuota_total}  ` +
        `${e.merchant ?? ""} — ${e.twins} twins on ${e.statements} statement(s)`
    );
  }

  const records = readCommaCsvRecords(csvPath) as CcStatementCsvRecord[];
  const byAccount = new Map<number, CcStatementCsvRecord[]>();
  for (const row of records) {
    const accountId = resolveMasterAccountIdForImportCardLast4(cardLast4FromParsedRow(row));
    if (accountId == null) continue;
    if (Number.isFinite(onlyAccount) && onlyAccount > 0 && accountId !== onlyAccount) continue;
    const list = byAccount.get(accountId) ?? [];
    list.push(row);
    byAccount.set(accountId, list);
  }

  const evidenceAccounts = new Set(evidence.map((e) => e.account_id));
  const repairedAccounts = new Set<number>();
  for (const [accountId, rows] of [...byAccount].sort((a, b) => a[0] - b[0])) {
    const chains = [...groupInstallmentLoanChains(rows).values()];
    const twinLoans = new Set(chains.filter((c) => c.twin_index > 0).map((c) => c.loan_key));
    if (twinLoans.size === 0) continue;
    repairedAccounts.add(accountId);
    const twinChains = chains.filter((c) => twinLoans.has(c.loan_key));

    console.log(`\n# account ${accountId}: ${twinLoans.size} twin loan(s) in the parsed statements`);
    for (const loan of twinLoans) {
      const [cardGroup, purchaseIso, amount, cuotas, merchant] = loan.split("\t");
      const loanChains = twinChains.filter((c) => c.loan_key === loan);
      const statements = new Set(loanChains.flatMap((c) => c.rows.map((r) => `${r.source_pdf}\t${r.statement_date}`)));
      console.log(
        `  group ${cardGroup}  ${purchaseIso}  ${fmt(Number(amount))} × ${cuotas}  ${merchant} — ` +
          `${loanChains.length} twins on ${statements.size} statement(s)`
      );
    }

    try {
      // IMMEDIATE: take the write lock before the first read. A deferred transaction reads its
      // "before" snapshot, and a commit by the running server in between makes the later write
      // fail with SQLITE_BUSY_SNAPSHOT.
      db.transaction(() => {
        const before = snapshot(accountId);
        mergeInstallmentLedgerFromParsedRows(
          accountId,
          twinChains.flatMap((c) => c.rows)
        );
        const after = snapshot(accountId);
        reportDiff(before, after);
        if (!apply) throw new ReportOnly();
      }).immediate();
      console.log(`  applied`);
    } catch (e) {
      if (!(e instanceof ReportOnly)) throw e;
      console.log(`  report only — rolled back (pass --apply to write)`);
    }
  }

  const uncovered = [...evidenceAccounts].filter(
    (id) => !repairedAccounts.has(id) && (!(onlyAccount > 0) || id === onlyAccount)
  );
  if (uncovered.length > 0) {
    throw new Error(
      `stored statement lines show installment twins on account(s) ${uncovered.join(", ")} but the parsed ` +
        `CSV has none to rebuild them from — re-parse (npm run parse:cc-pdfs) or check the source`
    );
  }
  if (repairedAccounts.size === 0) console.log("\nno twin loans to repair");
}

main();
