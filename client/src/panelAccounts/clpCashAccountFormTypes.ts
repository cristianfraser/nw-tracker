import { clpCashFlowKindAllowsCounterpart } from "./brokerageFlowKinds";
import { type InitialMovementDraft, parseOptionalNumber } from "./stockAccountFormTypes";

/** Body for `POST /api/accounts/:id/movements` on a CLP ledger cash account. */
export function buildClpCashMovementPostBody(
  row: InitialMovementDraft
): Record<string, unknown> | null {
  const occurred_on = row.occurredOn.trim();
  if (!occurred_on) return null;
  const amount_clp = parseOptionalNumber(row.amountClp);
  if (row.counterpartAccountId !== "" && clpCashFlowKindAllowsCounterpart(row.flowKind)) {
    if (amount_clp == null) return null;
    // Internal transfer leg: single from/to row, direction from the flow kind
    // (deposit = money arrives from the counterpart, withdrawal = money leaves to it).
    return {
      occurred_on,
      amount_clp: Math.abs(amount_clp),
      counterpart_account_id: row.counterpartAccountId,
      counterpart_role: row.flowKind === "deposit_clp" ? "from" : "to",
    };
  }
  return {
    occurred_on,
    flow_kind: row.flowKind,
    amount_clp,
  };
}
