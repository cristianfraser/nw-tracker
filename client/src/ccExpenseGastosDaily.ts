import type { FlowCcExpenseLineRow } from "./types";

/**
 * The calendar day a gastos line lands on (the flows overview's Diario).
 *
 * - One-shot purchases (and checking/manual lines) fall on the day the money moved:
 *   `purchase_on` for card lines, `occurred_on` otherwise.
 * - **Cuotas fall on their facturación's pay-by day.** A cuota has no transaction date of its
 *   own — it is billed by a statement and leaves the account on that statement's PAGAR HASTA —
 *   so the day view uses `cuota_pay_by_iso[account|billing_month]` from the server (billing
 *   calendars are never re-derived client-side).
 *
 * Consequence, documented because it surprises: in Cuotas mode a cuota billed in month M pays
 * ~10th of M+1, so Σ(cuota day buckets in calendar month M) equals the monthly split chart's
 * cuota sum at **M−1** — the same bank-frame(M) ≡ pay-frame(M+1) seam as the CC projections.
 *
 * Returns null when the line has no resolvable day (caller skips it); throws for card purchase
 * lines missing `purchase_on`, which is a parser/data regression rather than a display case.
 */
export function gastosDayForLine(
  line: FlowCcExpenseLineRow,
  payByIso: Record<string, string> | undefined
): string | null {
  if (line.line_role === "installment_cuota") {
    return payByIso?.[`${line.account_id}|${line.billing_month}`] ?? null;
  }
  if (line.source === "cc") {
    if (!line.purchase_on) {
      throw new Error(
        `gastos Diario: credit-card line ${line.statement_line_id} has no purchase_on`
      );
    }
    return line.purchase_on.slice(0, 10);
  }
  return line.occurred_on ? line.occurred_on.slice(0, 10) : null;
}
