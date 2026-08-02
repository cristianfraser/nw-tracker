import i18n from "../../i18n";
import { formatClp, formatPct } from "../../format";
import type { CcProxyLotResult } from "../../types/creditCard";

/** `formatClp` puts negatives in parens, so only the positive case needs an explicit sign. */
function signedClp(n: number): string {
  return `${n >= 0 ? "+" : ""}${formatClp(Math.round(n))}`;
}

function signedPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${formatPct(n)}`;
}

/**
 * Inline proxy line for one cuota row: what that cuota's own slice earned, and the whole
 * purchase's P/L at that date (withdrawn slices + the principal still invested).
 * Shared so the desktop table and the mobile card can't drift apart.
 */
export function proxyCuotaLine(
  proxy: CcProxyLotResult | undefined,
  ticker: string,
  payByDate: string
): string | null {
  const r = proxy?.by_ticker[ticker];
  const cuota = r?.cuotas?.find((c) => c.pay_by_date === payByDate);
  if (!cuota) return null;
  return i18n.t("account.creditCard.proxyCuotaReturn", {
    ticker,
    cuota: signedClp(cuota.realized_gain_clp),
    total: signedClp(cuota.total_gain_so_far_clp),
    pct: signedPct(cuota.total_return_so_far_pct),
  });
}
