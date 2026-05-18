import { isApvAAccountNote, depositFlowKindForApvAFintualRow } from "./apvAFintualFlowOverrides.js";
import {
  DEPOSIT_FLOW_KIND_PERSONAL,
  DEPOSIT_FLOW_KIND_STATE,
  DEPOSIT_FLOW_KIND_TRASPASO,
  depositFlowKindFromMovementNote,
  depositFlowKindLabel,
  type DepositFlowKind,
} from "./depositFlowKind.js";
import { db } from "./db.js";

export const FLOW_KIND_PAGO_CUOTA_HIPOTECARIO = "pago_cuota_hipotecario" as const;
export const FLOW_KIND_PREPAGO_PARCIAL_HIPOTECARIO = "prepago_parcial_hipotecario" as const;

export type MortgageFlowKind =
  | typeof FLOW_KIND_PAGO_CUOTA_HIPOTECARIO
  | typeof FLOW_KIND_PREPAGO_PARCIAL_HIPOTECARIO;

export type MovementFlowType =
  | DepositFlowKind
  | MortgageFlowKind
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
  switch (flowType) {
    case DEPOSIT_FLOW_KIND_PERSONAL:
    case DEPOSIT_FLOW_KIND_STATE:
    case DEPOSIT_FLOW_KIND_TRASPASO:
      return depositFlowKindLabel(flowType);
    case "withdrawal_clp":
      return "Retiro";
    case FLOW_KIND_PAGO_CUOTA_HIPOTECARIO:
      return "Pago cuota hipotecario";
    case FLOW_KIND_PREPAGO_PARCIAL_HIPOTECARIO:
      return "Prepago parcial hipotecario";
    default:
      return "Otro";
  }
}
