import { db } from "./db.js";

const BILLING_MONTH_RE = /^\d{4}-\d{2}$/;

export function isValidBillingMonthYm(ym: string): boolean {
  return BILLING_MONTH_RE.test(ym);
}

export function loadCcFacturadoPlaceholdersMap(accountId: number): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT billing_month, estimated_facturado_clp
       FROM cc_billing_facturado_placeholders
       WHERE account_id = ?`
    )
    .all(accountId) as { billing_month: string; estimated_facturado_clp: number }[];
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.estimated_facturado_clp > 0) out.set(r.billing_month, r.estimated_facturado_clp);
  }
  return out;
}

export function upsertCcFacturadoPlaceholder(
  accountId: number,
  billingMonth: string,
  estimatedFacturadoClp: number | null
): void {
  if (!isValidBillingMonthYm(billingMonth)) {
    throw new Error("invalid billing_month");
  }
  if (
    estimatedFacturadoClp == null ||
    !Number.isFinite(estimatedFacturadoClp) ||
    estimatedFacturadoClp <= 0
  ) {
    db.prepare(
      `DELETE FROM cc_billing_facturado_placeholders WHERE account_id = ? AND billing_month = ?`
    ).run(accountId, billingMonth);
    return;
  }
  const amount = Math.round(estimatedFacturadoClp);
  db.prepare(
    `INSERT INTO cc_billing_facturado_placeholders (account_id, billing_month, estimated_facturado_clp, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(account_id, billing_month) DO UPDATE SET
       estimated_facturado_clp = excluded.estimated_facturado_clp,
       updated_at = excluded.updated_at`
  ).run(accountId, billingMonth, amount);
}
