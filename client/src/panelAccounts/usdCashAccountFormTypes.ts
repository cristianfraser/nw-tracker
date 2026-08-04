import {
  brokerageFlowKindNeedsClp,
  brokerageFlowKindNeedsUsd,
  counterpartRoleForBrokerageFlowKind,
  isInterestFlowKind,
} from "./brokerageFlowKinds";
import { type InitialMovementDraft, parseOptionalNumber } from "./stockAccountFormTypes";

/** Body for `POST /api/accounts/:id/movements` on a USD cash account. */
export function buildUsdCashMovementPostBody(
  row: InitialMovementDraft
): Record<string, unknown> | null {
  const occurred_on = row.occurredOn.trim();
  if (!occurred_on) return null;
  // Interest on a USD cash account is entered in USD. Only submit the fields the form shows so a
  // stale value in a hidden input isn't sent.
  const showClp = brokerageFlowKindNeedsClp(row.flowKind);
  const showUsd = brokerageFlowKindNeedsUsd(row.flowKind) || isInterestFlowKind(row.flowKind);
  const clp = showClp ? parseOptionalNumber(row.amountClp) : null;
  const usd = showUsd ? parseOptionalNumber(row.amountUsd) : null;
  return {
    occurred_on,
    flow_kind: row.flowKind,
    // A kind showing both fields (compra_usd_venta_clp) sends CLP as the amount, USD as counter.
    ...(clp != null
      ? {
          amount: clp,
          currency: "clp",
          ...(usd != null ? { counter_amount: usd, counter_currency: "usd" } : {}),
        }
      : usd != null
        ? { amount: usd, currency: "usd" }
        : {}),
    ...(row.counterpartAccountId !== ""
      ? {
          counterpart_account_id: row.counterpartAccountId,
          counterpart_role: counterpartRoleForBrokerageFlowKind(row.flowKind, "cash"),
        }
      : {}),
  };
}
