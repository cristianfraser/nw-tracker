/** Mirrors server `movementCreateSchemaForAccount` on account summary / detail bundle. */
export type MovementCreateSchema = {
  ledger: "movements";
  units_delta: "required" | "optional";
  unit_label: string;
  brokerage_flow_kinds?: readonly string[];
  units_required_for_flow_kinds?: readonly string[];
};

export function supportsBrokerageMovements(
  schema: unknown
): schema is MovementCreateSchema {
  if (typeof schema !== "object" || schema == null) return false;
  const kinds = (schema as MovementCreateSchema).brokerage_flow_kinds;
  return Array.isArray(kinds) && kinds.length > 0;
}

/** USD cash ledger (not stock): `compra_usd_venta_clp`, no share flow kinds. */
export function supportsUsdCashMovements(schema: unknown): boolean {
  if (!supportsBrokerageMovements(schema)) return false;
  const kinds = schema.brokerage_flow_kinds as readonly string[];
  return kinds.includes("compra_usd_venta_clp") && !kinds.includes("stock_buy");
}

/**
 * Cuota/coin accounts (Fintual v2, crypto, AFP): units required, no brokerage flow kinds.
 * These take the manual aporte/retiro form (CLP + cuotas + counterpart transfer).
 */
export function supportsUnitsFlowMovements(
  schema: unknown
): schema is MovementCreateSchema {
  if (typeof schema !== "object" || schema == null) return false;
  const s = schema as MovementCreateSchema;
  return s.units_delta === "required" && !supportsBrokerageMovements(schema);
}
