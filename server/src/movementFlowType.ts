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

const MORTGAGE_FLOW_KIND_RE =
  /\|flow_kind=(pago_cuota_hipotecario|prepago_parcial_hipotecario)(?:\||$)/;

function mortgageFlowKindFromNote(note: string): MortgageFlowKind | null {
  const explicit = note.match(MORTGAGE_FLOW_KIND_RE);
  if (explicit) return explicit[1] as MortgageFlowKind;
  if (!note.includes("import:excel|depto-mortgage") && !note.includes("manual|depto-mortgage")) {
    return null;
  }
  const cuotaRaw = note.match(/\|cuota=([^|]+)/)?.[1];
  const cuota = cuotaRaw ? decodeURIComponent(cuotaRaw) : "";
  if (/^prepago\b/i.test(cuota.trim())) return FLOW_KIND_PREPAGO_PARCIAL_HIPOTECARIO;
  return FLOW_KIND_PAGO_CUOTA_HIPOTECARIO;
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
  // Deposit flow kind is resolved at import time and stored in the column (never parsed from the note).
  if (isDepositFlowKind(row.flow_kind)) return row.flow_kind;
  return movementFlowTypeFromSignedClp(row.note, row.amount_clp);
}

/**
 * Fallback classifier for movements whose `flow_kind` column is unset: mortgage kinds still come
 * from the depto note (until that ledger moves to its own table), otherwise the sign decides
 * withdrawal vs plain personal deposit.
 */
export function movementFlowTypeFromSignedClp(
  note: string | null | undefined,
  amount_clp: number
): MovementFlowType {
  if (note?.includes("cripto-coin-only-wdw")) return "other";
  const mortgageKind = note ? mortgageFlowKindFromNote(note) : null;
  if (mortgageKind) return mortgageKind;
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
