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
  return {
    occurred_on,
    flow_kind: row.flowKind,
    ...(showClp ? { amount_clp: parseOptionalNumber(row.amountClp) } : {}),
    ...(showUsd ? { amount_usd: parseOptionalNumber(row.amountUsd) } : {}),
    ...(row.counterpartAccountId !== ""
      ? {
          counterpart_account_id: row.counterpartAccountId,
          counterpart_role: counterpartRoleForBrokerageFlowKind(row.flowKind),
        }
      : {}),
  };
}
