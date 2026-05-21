import { isApvAAccountNote, depositFlowKindForApvAFintualRow } from "./apvAFintualFlowOverrides.js";
import {
  DEPOSIT_FLOW_KIND_PERSONAL,
  DEPOSIT_FLOW_KIND_STATE,
  DEPOSIT_FLOW_KIND_TRASPASO,
  depositFlowKindFromMovementNote,
  depositFlowKindLabel,
  type DepositFlowKind,
} from "./depositFlowKind.js";
import {
  BROKERAGE_FLOW_KIND_LABELS,
  isBrokerageFlowKind,
  type BrokerageFlowKind,
} from "./brokerageFlowMovement.js";
import { db } from "./db.js";

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
  if (!note.includes("import:excel|depto-mortgage")) return null;
  const cuotaRaw = note.match(/\|cuota=([^|]+)/)?.[1];
  const cuota = cuotaRaw ? decodeURIComponent(cuotaRaw) : "";
  if (/^prepago\b/i.test(cuota.trim())) return FLOW_KIND_PREPAGO_PARCIAL_HIPOTECARIO;
  return FLOW_KIND_PAGO_CUOTA_HIPOTECARIO;
}

function depositFlowKindToMovementFlowType(kind: DepositFlowKind): MovementFlowType {
  return kind;
}

function resolveMovementDepositFlowKind(
  accountId: number,
  occurred_on: string,
  amount_clp: number,
  note: string | null
): DepositFlowKind {
  const acct = db.prepare(`SELECT notes FROM accounts WHERE id = ?`).get(accountId) as
    | { notes: string | null }
    | undefined;
  if (isApvAAccountNote(acct?.notes)) {
    const medio = note?.match(/\|medio=([^|]+)/)?.[1] ?? "";
    return depositFlowKindForApvAFintualRow(occurred_on, amount_clp, medio, note);
  }
  return depositFlowKindFromMovementNote(note);
}

export function movementFlowTypeFromRow(row: {
  note: string | null | undefined;
  amount_clp: number;
  flow_kind?: string | null;
  accountId?: number;
  movementId?: number;
  occurred_on?: string;
}): MovementFlowType {
  if (isBrokerageFlowKind(row.flow_kind)) return row.flow_kind;
  return movementFlowTypeFromSignedClp(
    row.note,
    row.amount_clp,
    row.accountId,
    row.movementId,
    row.occurred_on
  );
}

export function movementFlowTypeFromSignedClp(
  note: string | null | undefined,
  amount_clp: number,
  accountId?: number,
  movementId?: number,
  occurred_on?: string
): MovementFlowType {
  if (note?.includes("cripto-coin-only-wdw")) return "other";
  const mortgageKind = note ? mortgageFlowKindFromNote(note) : null;
  if (mortgageKind) return mortgageKind;
  if (amount_clp < 0) return "withdrawal_clp";
  if (amount_clp === 0 || !Number.isFinite(amount_clp)) return "other";

  if (accountId != null && occurred_on) {
    return depositFlowKindToMovementFlowType(
      resolveMovementDepositFlowKind(accountId, occurred_on, amount_clp, note ?? null)
    );
  }

  const kind = depositFlowKindFromMovementNote(note);
  return depositFlowKindToMovementFlowType(kind);
}

export function movementFlowTypeLabel(flowType: MovementFlowType): string {
  if (isBrokerageFlowKind(flowType)) {
    return BROKERAGE_FLOW_KIND_LABELS[flowType];
  }
  if (
    flowType === DEPOSIT_FLOW_KIND_PERSONAL ||
    flowType === DEPOSIT_FLOW_KIND_STATE ||
    flowType === DEPOSIT_FLOW_KIND_TRASPASO
  ) {
    return depositFlowKindLabel(flowType);
  }
  if (flowType === "withdrawal_clp") return "Retiro";
  if (flowType === FLOW_KIND_PAGO_CUOTA_HIPOTECARIO) return "Pago cuota hipotecario";
  if (flowType === FLOW_KIND_PREPAGO_PARCIAL_HIPOTECARIO) return "Prepago parcial hipotecario";
  return "Otro";
}
