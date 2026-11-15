/** Signed CLP for charts / deposit merge (`deposit` +, `withdrawal` −, trades often 0). */
export function signedAmountClpForBrokerageFlow(
  flow_kind: string,
  amount_clp: number | null,
  amount_usd: number | null
): number {
  switch (flow_kind) {
    case "deposit":
      return amount_clp != null && Number.isFinite(amount_clp) ? Math.abs(amount_clp) : 0;
    case "withdrawal":
      return amount_clp != null && Number.isFinite(amount_clp) ? -Math.abs(amount_clp) : 0;
    case "fx_exchange":
      return amount_clp != null && Number.isFinite(amount_clp) ? -Math.abs(amount_clp) : 0;
    // Commission charged to the cash balance — always a debit (P/L cost, not capital).
    case "cash_fee":
      return amount_clp != null && Number.isFinite(amount_clp) ? -Math.abs(amount_clp) : 0;
    default:
      return amount_clp != null && Number.isFinite(amount_clp) ? amount_clp : 0;
  }
}
