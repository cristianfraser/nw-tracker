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
