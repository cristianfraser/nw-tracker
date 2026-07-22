/**
 * Daily «deuda en cuotas» for a CC master: +full contract value on each schedule purchase's
 * date, −each facturación's billed cuotas on their pay-by date (`facturaciones.pay_by_iso`;
 * ~10th of the following month when a closed statement never printed one). Serves the
 * account page's daily historial chart alongside the per-day owed walk. CLP only — the
 * historial chart is CLP-native like its monthly form.
 */
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import { listSchedulePurchaseEvents } from "./ccInstallmentLedgerDb.js";
import { buildCcInstallmentDebtDailySeries } from "./creditCardChartSeries.js";

function tenthOfNextMonthIso(billingMonth: string): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(billingMonth);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const next = new Date(Date.UTC(y, mo, 10));
  return next.toISOString().slice(0, 10);
}

/** Per-day plan debt aligned with `datesAsc`; null when the account has no schedule. */
export function ccInstallmentDebtDailyClp(
  accountId: number,
  datesAsc: readonly string[]
): (number | null)[] | null {
  const purchases = listSchedulePurchaseEvents(accountId);
  if (purchases.length === 0) return null;
  const { detail, facturaciones } = billingDetailCacheForAccount(accountId);
  const payByMonth = new Map(
    facturaciones
      .filter((f) => f.pay_by_iso != null)
      .map((f) => [f.billing_month, f.pay_by_iso!] as const)
  );
  const events: { iso: string; clp: number }[] = purchases.map((p) => ({ ...p }));
  for (const d of detail) {
    const amt = d.cuota_a_pagar_next_mes_clp;
    if (!Number.isFinite(amt) || amt <= 0) continue;
    const iso = payByMonth.get(d.billing_month) ?? tenthOfNextMonthIso(d.billing_month);
    if (!iso) continue;
    events.push({ iso, clp: -Math.round(amt) });
  }
  return buildCcInstallmentDebtDailySeries(datesAsc, events);
}
