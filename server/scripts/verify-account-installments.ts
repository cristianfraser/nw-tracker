/**
 *   npx tsx server/scripts/verify-account-installments.ts --account-id=32
 */
import { db } from "../src/db.js";
import {
  ccInstallmentsDbApiPayload,
  installmentPurchaseLedgerDedupeKey,
} from "../src/ccInstallmentLedgerDb.js";

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  return hit?.slice(p.length);
}

const targets = process.argv
  .filter((a) => a.startsWith("--canonical="))
  .map((a) => a.slice("--canonical=".length));

function main() {
  const accountId = Number(arg("account-id") ?? "32");
  const payload = ccInstallmentsDbApiPayload(accountId);
  const all = [
    ...payload.purchases,
    ...payload.purchases_completed,
    ...payload.hidden_cancelled_purchases,
  ];
  const ids = targets.length
    ? targets
    : ["ea86ae98c27a7a45", "b53cf5da65289277", "1cc0ca75414834be", "f92f5bf2e7f9c81c", "c4774a3371ffb362"];

  for (const canonical of ids) {
    const row = all.find((p) => p.purchase_id === canonical);
    console.log(
      JSON.stringify({
        canonical,
        found: Boolean(row),
        installments_paid: row?.installments_paid,
        remaining_installments: row?.remaining_installments,
        remaining_principal_clp: row?.remaining_principal_clp,
        in_active: payload.purchases.some((p) => p.purchase_id === canonical),
        in_hidden: payload.hidden_cancelled_purchases.some((p) => p.purchase_id === canonical),
        payments: row?.payment_statements?.length ?? 0,
      })
    );
  }

  const rows = db
    .prepare(
      `SELECT id, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales, merchant
       FROM cc_installment_purchases WHERE account_id = ?`
    )
    .all(accountId) as {
    id: number;
    canonical_row_id: string;
    purchase_date: string;
    total_amount_clp: number;
    cuotas_totales: number;
    merchant: string | null;
  }[];
  const byFp = new Map<string, number[]>();
  for (const r of rows) {
    const k = installmentPurchaseLedgerDedupeKey(r);
    const ids = byFp.get(k) ?? [];
    ids.push(r.id);
    byFp.set(k, ids);
  }
  const dups = [...byFp.values()].filter((ids) => ids.length > 1).length;
  console.log(
    JSON.stringify({
      purchase_count: rows.length,
      duplicate_fingerprint_groups: dups,
      active: payload.purchases.length,
      completed: payload.purchases_completed.length,
      hidden_cancelled: payload.hidden_cancelled_purchases.length,
    })
  );
}

main();
