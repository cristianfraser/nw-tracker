import type { MovementCreateSchema } from "nw-tracker-contracts/dto/ledgerSchemas";

export type { MovementCreateSchema };

export function supportsBrokerageMovements(
  schema: unknown
): schema is MovementCreateSchema {
  if (typeof schema !== "object" || schema == null) return false;
  const kinds = (schema as MovementCreateSchema).brokerage_flow_kinds;
  return Array.isArray(kinds) && kinds.length > 0;
}

/**
 * The currency of a cash ledger account's movement form (pesos, dollars, euros, any code of
 * `/api/currencies`), as the server states it on the schema; null for any other account.
 */
export function cashMovementsCurrency(schema: unknown): string | null {
  if (!supportsBrokerageMovements(schema)) return null;
  return schema.cash_currency ?? null;
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
