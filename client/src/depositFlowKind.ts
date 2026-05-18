/** Personal capital flow kinds (excludes APV-A state bonus). Signed amounts: withdrawals/rescates are negative. */
const PERSONAL_FLOW_TYPES = new Set(["deposit_clp", "traspaso_bonificacion_clp"]);

export function isPersonalCapitalFlowType(flowType: string | null | undefined): boolean {
  return flowType != null && PERSONAL_FLOW_TYPES.has(flowType);
}
