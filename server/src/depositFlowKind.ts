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

const FLOW_KIND_RE =
  /\|flow_kind=(deposit_clp|aporte_estatal_clp|traspaso_bonificacion_clp)(?:\||$)/;

/** Flow kinds that count as capital you contributed (full + display deposit series). */
export function isPersonalCapitalFlowKind(kind: DepositFlowKind): boolean {
  return kind === DEPOSIT_FLOW_KIND_PERSONAL || kind === DEPOSIT_FLOW_KIND_TRASPASO;
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

/** Classify an existing movement `note` (explicit `flow_kind` or `medio=` on cert rows). */
export function depositFlowKindFromMovementNote(note: string | null | undefined): DepositFlowKind {
  if (!note) return DEPOSIT_FLOW_KIND_PERSONAL;
  const explicit = note.match(FLOW_KIND_RE);
  if (explicit) return explicit[1] as DepositFlowKind;

  if (isFintualTraspasoBonificacionOtraInstitucion(note)) return DEPOSIT_FLOW_KIND_TRASPASO;

  if (!note.includes("fintual-certificado")) return DEPOSIT_FLOW_KIND_PERSONAL;

  const medioPart = note.match(/\|medio=([^|]+)/)?.[1];
  if (!medioPart) return DEPOSIT_FLOW_KIND_PERSONAL;

  const medios = medioPart
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  if (medios.length === 0) return DEPOSIT_FLOW_KIND_PERSONAL;

  const kinds = medios.map(depositFlowKindFromFintualMedio);
  if (kinds.every((k) => k === DEPOSIT_FLOW_KIND_STATE)) return DEPOSIT_FLOW_KIND_STATE;
  if (kinds.some((k) => k === DEPOSIT_FLOW_KIND_TRASPASO)) return DEPOSIT_FLOW_KIND_TRASPASO;
  return DEPOSIT_FLOW_KIND_PERSONAL;
}

export function movementCountsAsPersonalDeposit(note: string | null | undefined): boolean {
  return isPersonalCapitalFlowKind(depositFlowKindFromMovementNote(note));
}

export function movementIsStateContribution(note: string | null | undefined): boolean {
  return depositFlowKindFromMovementNote(note) === DEPOSIT_FLOW_KIND_STATE;
}
