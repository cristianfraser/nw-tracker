/**
 * The two comparisons every installment matcher shares: whether two purchase amounts agree, and
 * whether two merchant names are the same installment merchant. A one-shot line, a cuota line and
 * a plan's total line are all asked these questions, and must get the same answer.
 */
import { merchantStemForInstallmentDedupe } from "../ccInstallmentLineDedupe.js";

/** Two purchase amounts agree to 2 % (at least 500 pesos): statement and listing round differently. */
export function purchaseAmountsMatch(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return false;
  const tol = Math.max(500, Math.round(0.02 * Math.max(a, b)));
  return Math.abs(a - b) <= tol;
}

/**
 * Whether `amountClp` is a plan's full principal or one cuota of it. The bank's site lists a
 * purchase at its total when bought and later as the per-cuota charge that will post, so a line of
 * either size belongs to the plan.
 */
export function amountIsPrincipalOrOneCuota(totalClp: number, cuotas: number | null | undefined, amountClp: number): boolean {
  if (purchaseAmountsMatch(totalClp, amountClp)) return true;
  if (cuotas && cuotas > 1 && Number.isFinite(totalClp) && totalClp > 0) {
    return purchaseAmountsMatch(Math.round(totalClp / cuotas), amountClp);
  }
  return false;
}

/** Whether two merchant names have the same installment stem (one may extend the other). */
export function installmentMerchantStemsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const sa = merchantStemForInstallmentDedupe(a);
  const sb = merchantStemForInstallmentDedupe(b);
  if (!sa || !sb) return false;
  const ua = sa.toUpperCase();
  const ub = sb.toUpperCase();
  return ua === ub || ua.startsWith(ub) || ub.startsWith(ua);
}
