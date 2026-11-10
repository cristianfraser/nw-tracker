/**
 * How many contracts an option account holds on a day: Σ `units_delta` over the option kinds
 * (`optionFlowKinds.ts`), each leg signed by `unitsDeltaForAccountMovement` — a short position
 * is negative. The ledger side of `optionContracts.ts`.
 */
import { sumUnitsThroughDate } from "./movementTransfer.js";
import { OPTION_UNITS_FLOW_KINDS } from "./optionFlowKinds.js";

/** Signed contracts held on or before `asOfYmd` (0 when none). */
export function optionContractsThroughDate(accountId: number, asOfYmd: string): number {
  return sumUnitsThroughDate(accountId, asOfYmd, OPTION_UNITS_FLOW_KINDS);
}
