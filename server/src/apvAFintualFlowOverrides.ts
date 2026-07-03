import {
  DEPOSIT_FLOW_KIND_STATE,
  DEPOSIT_FLOW_KIND_TRASPASO,
  depositFlowKindFromFintualMedio,
  isFintualBonificacionDelEstadoMedio,
  isFintualTraspasoBonificacionOtraInstitucion,
  type DepositFlowKind,
} from "./depositFlowKind.js";

export const APV_A_ACCOUNT_NOTE = "import:excel|key=apv_a";

export function isApvAAccountNote(notes: string | null | undefined): boolean {
  return notes === APV_A_ACCOUNT_NOTE;
}

/**
 * Classify APV-a Fintual flows from movement notes (`|flow_kind=…|`) and certificado `|medio=…` labels.
 */
export function depositFlowKindForApvAFintualRow(
  _occurred_on: string,
  _amount_clp: number,
  medio: string,
  note: string | null | undefined
): DepositFlowKind {
  const fromNote = note?.match(
    /\|flow_kind=(deposit_clp|aporte_estatal_clp|traspaso_bonificacion_clp)(?:\||$)/
  )?.[1] as DepositFlowKind | undefined;
  if (fromNote) return fromNote;

  const medioAndComment = [medio, note ?? ""].filter(Boolean).join(" ");
  if (isFintualTraspasoBonificacionOtraInstitucion(medioAndComment)) {
    return DEPOSIT_FLOW_KIND_TRASPASO;
  }
  if (isFintualBonificacionDelEstadoMedio(medio)) return DEPOSIT_FLOW_KIND_STATE;

  return depositFlowKindFromFintualMedio(medio);
}
