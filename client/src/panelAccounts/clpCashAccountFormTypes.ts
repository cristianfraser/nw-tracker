import { type InitialMovementDraft, parseOptionalNumber } from "./stockAccountFormTypes";

/** Body for `POST /api/accounts/:id/movements` on a CLP ledger cash account. */
export function buildClpCashMovementPostBody(
  row: InitialMovementDraft
): Record<string, unknown> | null {
  const occurred_on = row.occurredOn.trim();
  if (!occurred_on) return null;
  return {
    occurred_on,
    flow_kind: row.flowKind,
    amount_clp: parseOptionalNumber(row.amountClp),
  };
}
