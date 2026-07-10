/** Personal wire / transferencia (your money). */
export const DEPOSIT_FLOW_KIND_PERSONAL = "deposit_clp" as const;
/** Chile APV-A state bonus (~15% of prior-year deposits, capped). */
export const DEPOSIT_FLOW_KIND_STATE = "aporte_estatal_clp" as const;
/** Prior AFP state bonus transferred in from another institution (still your capital). */
export const DEPOSIT_FLOW_KIND_TRASPASO = "traspaso_bonificacion_clp" as const;

export type DepositFlowKind =
  | typeof DEPOSIT_FLOW_KIND_PERSONAL
  | typeof DEPOSIT_FLOW_KIND_STATE
  | typeof DEPOSIT_FLOW_KIND_TRASPASO;

/** Flow kinds that count as capital you contributed (full + display deposit series). */
export function isPersonalCapitalFlowKind(kind: DepositFlowKind): boolean {
  return kind === DEPOSIT_FLOW_KIND_PERSONAL || kind === DEPOSIT_FLOW_KIND_TRASPASO;
}

/** True when a `movements.flow_kind` column value is one of the deposit flow kinds. */
export function isDepositFlowKind(flowKind: string | null | undefined): flowKind is DepositFlowKind {
  return (
    flowKind === DEPOSIT_FLOW_KIND_PERSONAL ||
    flowKind === DEPOSIT_FLOW_KIND_STATE ||
    flowKind === DEPOSIT_FLOW_KIND_TRASPASO
  );
}

export function depositFlowKindLabel(kind: DepositFlowKind): string {
  switch (kind) {
    case DEPOSIT_FLOW_KIND_PERSONAL:
      return "Depósito";
    case DEPOSIT_FLOW_KIND_STATE:
      return "Aporte estatal";
    case DEPOSIT_FLOW_KIND_TRASPASO:
      return "Traspaso bonificación (otra Institución)";
  }
}

/** Normalize Fintual `Medio` for matching (lowercase, no accents, spaces → `_`). */
export function normalizeFintualMedio(medio: string): string {
  return medio
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, "_");
}

/** Fintual: transfer of state bonus balance from another AFP (personal capital, distinct tipo). */
export function isFintualTraspasoBonificacionOtraInstitucion(text: string): boolean {
  const n = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ");
  if (!n.includes("traspaso")) return false;
  if (!n.includes("bonificacion") && !n.includes("bono")) return false;
  return n.includes("otra institucion") || n.includes("desde otra");
}

/** Fintual certificate / API labels for the APV-A state bonus (e.g. `Deposito CL` → `deposito_cl`). */
export function isFintualStateBonusMedio(medio: string): boolean {
  const n = normalizeFintualMedio(medio);
  if (!n) return false;
  if (/^deposito[_\s-]?cl(p)?$/.test(n)) return true;
  if (/^aporte[_\s-]?estatal/.test(n)) return true;
  if (/^bonificacion[_\s-]?estatal/.test(n)) return true;
  if (/^bono[_\s-]?estatal/.test(n)) return true;
  return false;
}

export function isFintualBonificacionDelEstadoMedio(medio: string): boolean {
  const n = normalizeFintualMedio(medio).replace(/_/g, " ");
  if (/^bonificacion del estado$/.test(n)) return true;
  if (/^bonificacion estatal$/.test(n)) return true;
  return false;
}

export function depositFlowKindFromFintualMedio(medio: string): DepositFlowKind {
  if (isFintualTraspasoBonificacionOtraInstitucion(medio)) return DEPOSIT_FLOW_KIND_TRASPASO;
  if (isFintualBonificacionDelEstadoMedio(medio) || isFintualStateBonusMedio(medio)) {
    return DEPOSIT_FLOW_KIND_STATE;
  }
  return DEPOSIT_FLOW_KIND_PERSONAL;
}

/**
 * Deposit flow kind from the `movements.flow_kind` column. Deposit classification is resolved at
 * import time (see `fintualCertImport.ts`) and stored in the column — never parsed from the note.
 * A null/unknown value is a plain personal deposit.
 */
export function depositFlowKindFromColumn(flowKind: string | null | undefined): DepositFlowKind {
  if (flowKind === DEPOSIT_FLOW_KIND_STATE) return DEPOSIT_FLOW_KIND_STATE;
  if (flowKind === DEPOSIT_FLOW_KIND_TRASPASO) return DEPOSIT_FLOW_KIND_TRASPASO;
  return DEPOSIT_FLOW_KIND_PERSONAL;
}

export function movementCountsAsPersonalDeposit(flowKind: string | null | undefined): boolean {
  return isPersonalCapitalFlowKind(depositFlowKindFromColumn(flowKind));
}

export function movementIsStateContribution(flowKind: string | null | undefined): boolean {
  return depositFlowKindFromColumn(flowKind) === DEPOSIT_FLOW_KIND_STATE;
}
