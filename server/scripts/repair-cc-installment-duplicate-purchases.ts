/**
 * Consolidate duplicate cc_installment_purchases (non-destructive to statements).
 *
 *   npx tsx server/scripts/repair-cc-installment-duplicate-purchases.ts --account-id=32
 *   npx tsx server/scripts/repair-cc-installment-duplicate-purchases.ts --account-id=32 --apply
 *   npx tsx server/scripts/repair-cc-installment-duplicate-purchases.ts --all --apply
 */
import { db } from "../src/db.js";
import {
  dedupeInstallmentPurchaseLedgerRows,
  installmentPurchaseLedgerDedupeKey,
} from "../src/ccInstallmentLedgerDb.js";
import { statementPeriodMonthFromParsedRow } from "../src/ccInstallmentStatementMonth.js";
import { parseDdMmYyToIso } from "../src/ccInstallmentPayBy.js";

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  return hit?.slice(p.length);
}

type PurchaseRow = {
  id: number;
  canonical_row_id: string;
  purchase_date: string;
  total_amount_clp: number;
  cuotas_totales: number;
  merchant: string | null;
};

type RepairStats = {
  groups: number;
  paymentsMoved: number;
  purchasesRemoved: number;
  stmtMonthsFilled: number;
};

function repairAccountInstallmentDuplicates(accountId: number, apply: boolean): RepairStats {
  const purchases = db
    .prepare(
      `SELECT id, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales, merchant
       FROM cc_installment_purchases WHERE account_id = ? ORDER BY id`
    )
    .all(accountId) as PurchaseRow[];

  const byFp = new Map<string, PurchaseRow[]>();
  for (const pr of purchases) {
    const fp = installmentPurchaseLedgerDedupeKey(pr);
    const list = byFp.get(fp) ?? [];
    list.push(pr);
    byFp.set(fp, list);
  }

  const repointPayment = db.prepare(`UPDATE cc_installment_payments SET purchase_id = ? WHERE id = ?`);
  const deletePayment = db.prepare(`DELETE FROM cc_installment_payments WHERE id = ?`);
  const deletePurchase = db.prepare(`DELETE FROM cc_installment_purchases WHERE id = ?`);
  const payOnPurchase = db.prepare(
    `SELECT id, pay_by_date, cuota_current FROM cc_installment_payments WHERE purchase_id = ?`
  );
  const backfillStmtMonth = db.prepare(
    `UPDATE cc_installment_payments
     SET statement_period_month = COALESCE(statement_period_month, ?)
     WHERE id = ?`
  );

  const stats: RepairStats = { groups: 0, paymentsMoved: 0, purchasesRemoved: 0, stmtMonthsFilled: 0 };

  const run = db.transaction(() => {
    for (const [fp, group] of byFp) {
      if (group.length <= 1) continue;
      stats.groups++;
      const kept = dedupeInstallmentPurchaseLedgerRows(group)[0]!;
      const siblings = group.filter((p) => p.id !== kept.id);
      console.log(
        `# account ${accountId} fingerprint ${JSON.stringify(fp)} keep id=${kept.id} canonical=${kept.canonical_row_id} drop=${siblings.map((s) => s.id).join(",")}`
      );
      for (const sib of siblings) {
        const pays = db
          .prepare(
            `SELECT id, pay_by_date, cuota_current FROM cc_installment_payments WHERE purchase_id = ?`
          )
          .all(sib.id) as { id: number; pay_by_date: string; cuota_current: number | null }[];
        for (const pay of pays) {
          if (apply) {
            const existing = (
              payOnPurchase.all(kept.id) as { id: number; pay_by_date: string; cuota_current: number | null }[]
            ).find((e) => e.pay_by_date === pay.pay_by_date);
            if (existing) {
              const keepExisting =
                (existing.cuota_current ?? 0) >= (pay.cuota_current ?? 0) && existing.id < pay.id;
              if (keepExisting) {
                deletePayment.run(pay.id);
              } else {
                deletePayment.run(existing.id);
                repointPayment.run(kept.id, pay.id);
                stats.paymentsMoved++;
              }
            } else {
              repointPayment.run(kept.id, pay.id);
              stats.paymentsMoved++;
            }
          } else {
            stats.paymentsMoved++;
          }
        }
        if (apply) {
          deletePurchase.run(sib.id);
          stats.purchasesRemoved++;
        }
      }
    }

    if (apply) {
      const missing = db
        .prepare(
          `SELECT p.id, p.statement_date, s.period_to
           FROM cc_installment_payments p
           JOIN cc_installment_purchases pr ON pr.id = p.purchase_id
           LEFT JOIN cc_statement_lines l ON l.parser_row_id = p.parser_row_id
           LEFT JOIN cc_statements s ON s.id = l.statement_id
           WHERE pr.account_id = ? AND (p.statement_period_month IS NULL OR p.statement_period_month = '')`
        )
        .all(accountId) as { id: number; statement_date: string | null; period_to: string | null }[];
      for (const row of missing) {
        const ym =
          statementPeriodMonthFromParsedRow({
            period_to: row.period_to,
            statement_date: row.statement_date,
          }) ??
          (row.statement_date
            ? statementPeriodMonthFromParsedRow({ statement_date: row.statement_date })
            : null);
        if (!ym && row.statement_date) {
          const iso = parseDdMmYyToIso(row.statement_date);
          if (iso) {
            backfillStmtMonth.run(iso.slice(0, 7), row.id);
            stats.stmtMonthsFilled++;
          }
        } else if (ym) {
          backfillStmtMonth.run(ym, row.id);
          stats.stmtMonthsFilled++;
        }
      }
    }
  });

  if (apply) {
    run();
  } else {
    for (const [fp, group] of byFp) {
      if (group.length <= 1) continue;
      stats.groups++;
      const kept = dedupeInstallmentPurchaseLedgerRows(group)[0]!;
      const siblings = group.filter((p) => p.id !== kept.id);
      for (const sib of siblings) {
        stats.paymentsMoved += (
          db.prepare(`SELECT COUNT(*) AS c FROM cc_installment_payments WHERE purchase_id = ?`).get(sib.id) as {
            c: number;
          }
        ).c;
        stats.purchasesRemoved++;
      }
      console.log(
        `[dry-run] account ${accountId} fingerprint ${JSON.stringify(fp)} keep id=${kept.id} drop ids=${siblings.map((s) => s.id).join(",")}`
      );
    }
  }

  return stats;
}

function accountIdsWithInstallmentLedger(): number[] {
  return (
    db
      .prepare(`SELECT DISTINCT account_id AS id FROM cc_installment_purchases ORDER BY account_id`)
      .all() as { id: number }[]
  ).map((r) => r.id);
}

function main() {
  const apply = process.argv.includes("--apply");
  const allAccounts = process.argv.includes("--all");
  const accountIdArg = arg("account-id");
  const accountId = accountIdArg != null ? Number(accountIdArg) : NaN;

  if (allAccounts) {
    const ids = accountIdsWithInstallmentLedger();
    let total: RepairStats = { groups: 0, paymentsMoved: 0, purchasesRemoved: 0, stmtMonthsFilled: 0 };
    for (const id of ids) {
      const stats = repairAccountInstallmentDuplicates(id, apply);
      total = {
        groups: total.groups + stats.groups,
        paymentsMoved: total.paymentsMoved + stats.paymentsMoved,
        purchasesRemoved: total.purchasesRemoved + stats.purchasesRemoved,
        stmtMonthsFilled: total.stmtMonthsFilled + stats.stmtMonthsFilled,
      };
    }
    console.log(
      apply
        ? `Applied (${ids.length} account(s)): ${total.groups} duplicate group(s), ${total.paymentsMoved} payment(s) repointed, ${total.purchasesRemoved} purchase row(s) removed, ${total.stmtMonthsFilled} statement_period_month backfilled.`
        : `[dry-run] ${ids.length} account(s): ${total.groups} duplicate group(s), would repoint ~${total.paymentsMoved} payment(s), remove ${total.purchasesRemoved} purchase row(s). Pass --apply to write.`
    );
    return;
  }

  if (!Number.isFinite(accountId) || accountId <= 0) {
    console.error("Use --account-id=NN or --all [--apply]");
    process.exit(1);
  }

  const stats = repairAccountInstallmentDuplicates(accountId, apply);
  console.log(
    apply
      ? `Applied: ${stats.groups} duplicate group(s), ${stats.paymentsMoved} payment(s) repointed, ${stats.purchasesRemoved} purchase row(s) removed, ${stats.stmtMonthsFilled} statement_period_month backfilled.`
      : `[dry-run] ${stats.groups} duplicate group(s), would repoint ~${stats.paymentsMoved} payment(s), remove ${stats.purchasesRemoved} purchase row(s). Pass --apply to write.`
  );
}

main();
