import {
  DEPOSIT_FLOW_KIND_PERSONAL,
  DEPOSIT_FLOW_KIND_STATE,
  DEPOSIT_FLOW_KIND_TRASPASO,
  depositFlowKindLabel,
  isDepositFlowKind,
  type DepositFlowKind,
} from "./depositFlowKind.js";
import {
  BROKERAGE_FLOW_KIND_LABELS,
  isBrokerageFlowKind,
  type BrokerageFlowKind,
} from "./brokerageFlowMovement.js";

export const FLOW_KIND_PAGO_CUOTA_HIPOTECARIO = "pago_cuota_hipotecario" as const;
export const FLOW_KIND_PREPAGO_PARCIAL_HIPOTECARIO = "prepago_parcial_hipotecario" as const;

export type MortgageFlowKind =
  | typeof FLOW_KIND_PAGO_CUOTA_HIPOTECARIO
  | typeof FLOW_KIND_PREPAGO_PARCIAL_HIPOTECARIO;

export type MovementFlowType =
  | DepositFlowKind
  | MortgageFlowKind
  | BrokerageFlowKind
  | "withdrawal_clp"
  | "other";

function isMortgageFlowKind(flowKind: string | null | undefined): flowKind is MortgageFlowKind {
  return (
    flowKind === FLOW_KIND_PAGO_CUOTA_HIPOTECARIO ||
    flowKind === FLOW_KIND_PREPAGO_PARCIAL_HIPOTECARIO
  );
}

function isDepositMovementFlowType(flowType: MovementFlowType): flowType is DepositFlowKind {
  return (
    flowType === DEPOSIT_FLOW_KIND_PERSONAL ||
    flowType === DEPOSIT_FLOW_KIND_STATE ||
    flowType === DEPOSIT_FLOW_KIND_TRASPASO
  );
}

export function movementFlowTypeFromRow(row: {
  note: string | null | undefined;
  amount_clp: number;
  flow_kind?: string | null;
  transfer_direction?: "out" | "in" | null;
}): MovementFlowType {
  if (row.transfer_direction === "out" || row.transfer_direction === "in") {
    if (isBrokerageFlowKind(row.flow_kind)) return row.flow_kind;
    return row.transfer_direction === "out" ? "withdrawal_clp" : "deposit_clp";
  }
  if (isBrokerageFlowKind(row.flow_kind)) return row.flow_kind;
  // Flow kind is resolved at write time and stored in the column (never parsed from the note).
  if (isMortgageFlowKind(row.flow_kind)) return row.flow_kind;
  if (isDepositFlowKind(row.flow_kind)) return row.flow_kind;
  return movementFlowTypeFromSignedClp(row.note, row.amount_clp);
}

/** Fallback for movements whose `flow_kind` column is unset: the sign decides. */
export function movementFlowTypeFromSignedClp(
  note: string | null | undefined,
  amount_clp: number
): MovementFlowType {
  if (note?.includes("cripto-coin-only-wdw")) return "other";
  if (amount_clp < 0) return "withdrawal_clp";
  if (amount_clp === 0 || !Number.isFinite(amount_clp)) return "other";
  return DEPOSIT_FLOW_KIND_PERSONAL;
}

export function movementFlowTypeLabel(flowType: MovementFlowType): string {
  if (isBrokerageFlowKind(flowType)) {
    return BROKERAGE_FLOW_KIND_LABELS[flowType];
  }
  const label = flowType as string;
  if (label === "withdrawal_clp") return "Retiro";
  if (label === FLOW_KIND_PAGO_CUOTA_HIPOTECARIO) return "Pago cuota hipotecario";
  if (label === FLOW_KIND_PREPAGO_PARCIAL_HIPOTECARIO) return "Prepago parcial hipotecario";
  if (isDepositMovementFlowType(flowType)) {
    return depositFlowKindLabel(flowType);
  }
  return "Otro";
}
