import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import { cancelledInstallmentPurchaseIdsForAccount } from "./ccInstallmentLedgerDb.js";
import { isPdfStatementSource } from "./ccManualBillingMonth.js";
import { listCcStatementsForAccount } from "./ccStatementsDb.js";
import { db } from "./db.js";

export type CcBilledCuotasMonth = {
  billing_month: string;
  /** Σ printed cuotas (installment lines with cuota ≥ 1) on the facturación's CLP statements. */
  billed_clp: number;
  /** The ledger's cuota a pagar for the facturación (plan schedule). */
  cuota_a_pagar_clp: number;
  /** Cuotas of nota-cancelled plans billed that month: printed, but out of the schedule by design. */
  cancelled_clp: number;
  /** billed − cuota a pagar − cancelled; 0 when the ledger carries every plan the statement bills. */
  unexplained_clp: number;
};

/**
 * Installment-ledger acceptance check: for every closed facturación of a card, the cuotas its
 * statement bills against the ledger's `cuota_a_pagar_clp`. A plan the ledger lacks (or holds
 * once for several identical purchases) shows up as an unexplained residual.
 */
export function ccBilledCuotasIdentity(accountId: number): CcBilledCuotasMonth[] {
  const sumPrintedCuotas = db.prepare(
    `SELECT COALESCE(SUM(valor_cuota_mensual_clp), 0) AS clp FROM cc_statement_lines
     WHERE statement_id = ? AND installment_flag = 1 AND nro_cuota_current >= 1`
  );
  const billedByMonth = new Map<string, number>();
  for (const st of listCcStatementsForAccount(accountId)) {
    if (st.currency === "usd" || !st.billing_month || !isPdfStatementSource(st.source_pdf)) continue;
    const { clp } = sumPrintedCuotas.get(st.id) as { clp: number };
    billedByMonth.set(st.billing_month, (billedByMonth.get(st.billing_month) ?? 0) + clp);
  }

  const cancelledByMonth = new Map<string, number>();
  const cancelledIds = [...cancelledInstallmentPurchaseIdsForAccount(accountId)];
  if (cancelledIds.length > 0) {
    const rows = db
      .prepare(
        `SELECT statement_period_month AS ym, SUM(amount_clp) AS clp FROM cc_installment_payments
         WHERE purchase_id IN (${cancelledIds.map(() => "?").join(",")})
           AND (parser_row_id IS NULL OR parser_row_id NOT LIKE 'synthetic:%')
         GROUP BY statement_period_month`
      )
      .all(...cancelledIds) as { ym: string | null; clp: number }[];
    for (const r of rows) if (r.ym) cancelledByMonth.set(r.ym, r.clp);
  }

  return billingDetailCacheForAccount(accountId)
    .facturaciones.filter((f) => !f.is_open_month && !f.is_provisional_close)
    .map((f) => {
      const billed = billedByMonth.get(f.billing_month) ?? 0;
      const cuotaAPagar = f.cuota_a_pagar_clp ?? 0;
      const cancelled = cancelledByMonth.get(f.billing_month) ?? 0;
      return {
        billing_month: f.billing_month,
        billed_clp: billed,
        cuota_a_pagar_clp: cuotaAPagar,
        cancelled_clp: cancelled,
        unexplained_clp: billed - cuotaAPagar - cancelled,
      };
    })
    .sort((a, b) => a.billing_month.localeCompare(b.billing_month));
}
