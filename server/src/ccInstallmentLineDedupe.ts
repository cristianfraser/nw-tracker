import { effectiveCcExpenseLineAmountClp } from "./ccExpenseAmountClp.js";

/**
 * Santander wide-layout statements often list each installment twice: * a contract summary row (N/CUOTAS PRECIO, TRES CUOTAS PREC, NN CUOTAS COMERC)
 * and a CUOTA COMERCIO row for the same merchant/cuota. Count only one.
 */

export type CcStatementLineForInstallmentTotals = {
  statement_line_id: number;
  /** Group key when one account has multiple statements on the same close date (e.g. CLP + USD PDF). */
  account_id: number;
  statement_date: string;
  merchant: string | null;
  installment_flag: number;
  amount_clp: number | null;
  amount_usd?: number | null;
  valor_cuota_mensual_clp: number | null;
  valor_cuota_mensual_usd?: number | null;
  nro_cuota_current?: number | null;
  nro_cuota_total?: number | null;
  statement_currency?: string | null;
  /** Statement close (ISO) for USD→CLP on dedupe comparisons. */
  fx_date_iso?: string | null;
};

/** PDF contract summary row — not a separate purchase from indexed cuota lines. */
export function isInstallmentContractSummaryMerchant(
  merchant: string | null | undefined
): boolean {
  const u = String(merchant ?? "").toUpperCase();
  if (!u) return false;
  return (
    u.includes("N/CUOTAS PRECIO") ||
    u.includes("TRES CUOTAS PREC") ||
    /\d{2}\s+CUOTAS\s+COMERC/.test(u) ||
    /\d{2}\s+CUOTAS,\s+TASA/.test(u)
  );
}

/** Merchant prefix before installment descriptor text. */
export function merchantStemForInstallmentDedupe(
  merchant: string | null | undefined
): string {
  const s = String(merchant ?? "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  const upper = s.toUpperCase();
  const markers = [
    " N/CUOTAS PRECIO",
    " TRES CUOTAS PREC",
    " CUOTAS COMERC",
    " CUOTAS, TASA",
    " CUOTA COMERCIO",
  ];
  let cutAt = s.length;
  for (const marker of markers) {
    const i = upper.indexOf(marker);
    if (i >= 0) cutAt = Math.min(cutAt, i);
  }
  return s.slice(0, cutAt).trim();
}

function stemsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const ua = a.toUpperCase();
  const ub = b.toUpperCase();
  return ua.startsWith(ub) || ub.startsWith(ua);
}

/** Plan resumen row (e.g. «03 CUOTAS, TASA») before indexed cuota lines appear on later statements. */
export function isUnindexedInstallmentResumenLine(
  line: Pick<
    CcStatementLineForInstallmentTotals,
    "installment_flag" | "nro_cuota_current" | "nro_cuota_total"
  > & { nro_cuota_current?: number | null; nro_cuota_total?: number | null }
): boolean {
  if (line.installment_flag !== 1) return false;
  const cur = line.nro_cuota_current;
  const tot = line.nro_cuota_total;
  if (cur != null && Number(cur) > 0) return false;
  return tot != null && Number(tot) > 0;
}

export function installmentCuotaAmountClp(
  row: CcStatementLineForInstallmentTotals
): number | null {
  const amount = effectiveCcExpenseLineAmountClp(
    {
      installment_flag: row.installment_flag,
      amount_clp: row.amount_clp,
      amount_usd: row.amount_usd ?? null,
      valor_cuota_mensual_clp: row.valor_cuota_mensual_clp,
      valor_cuota_mensual_usd: row.valor_cuota_mensual_usd ?? null,
      statement_currency: row.statement_currency ?? null,
    },
    row.fx_date_iso ?? null
  );
  if (amount == null || amount <= 0) return null;
  if (row.installment_flag === 1) return amount;
  if (isInstallmentContractSummaryMerchant(row.merchant)) return amount;
  return null;
}

/**
 * Summary rows superseded by a CUOTA COMERCIO (or similar) line on the same statement.
 */
export function redundantInstallmentSummaryLineIds(
  lines: CcStatementLineForInstallmentTotals[]
): Set<number> {
  const redundant = new Set<number>();
  const byAccount = new Map<number, CcStatementLineForInstallmentTotals[]>();
  for (const ln of lines) {
    const bucket = byAccount.get(ln.account_id) ?? [];
    bucket.push(ln);
    byAccount.set(ln.account_id, bucket);
  }

  for (const accountLines of byAccount.values()) {
    const canonical: { stem: string; cuota: number }[] = [];
    for (const ln of accountLines) {
      if (ln.installment_flag !== 1) continue;
      if (isInstallmentContractSummaryMerchant(ln.merchant)) continue;
      const cuota = installmentCuotaAmountClp(ln);
      if (cuota == null || cuota <= 0) continue;
      canonical.push({
        stem: merchantStemForInstallmentDedupe(ln.merchant),
        cuota,
      });
    }

    for (const ln of accountLines) {
      const isSummary =
        isInstallmentContractSummaryMerchant(ln.merchant) ||
        isUnindexedInstallmentResumenLine(ln);
      if (!isSummary) continue;
      const cuota = installmentCuotaAmountClp(ln);
      if (cuota == null || cuota <= 0) continue;
      const stem = merchantStemForInstallmentDedupe(ln.merchant);
      const hasCanonical = canonical.some(
        (c) =>
          stemsMatch(c.stem, stem) &&
          Math.abs(c.cuota - cuota) <= Math.max(500, Math.round(0.02 * c.cuota))
      );
      if (hasCanonical) redundant.add(ln.statement_line_id);
    }
  }

  return redundant;
}
