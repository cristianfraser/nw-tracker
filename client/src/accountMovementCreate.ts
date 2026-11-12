import type { MovementCreateSchema } from "nw-tracker-contracts/dto/ledgerSchemas";

export type { MovementCreateSchema };

export function supportsBrokerageMovements(
  schema: unknown
): schema is MovementCreateSchema {
  if (typeof schema !== "object" || schema == null) return false;
  const kinds = (schema as MovementCreateSchema).brokerage_flow_kinds;
  return Array.isArray(kinds) && kinds.length > 0;
}

/** Foreign cash ledger (not stock): `fx_exchange`, no share flow kinds. */
export function supportsUsdCashMovements(schema: unknown): boolean {
  if (!supportsBrokerageMovements(schema)) return false;
  const kinds = schema.brokerage_flow_kinds as readonly string[];
  return kinds.includes("fx_exchange") && !kinds.includes("stock_buy");
}

/** CLP ledger cash (base currency): `savings_earnings` + CLP deposits/withdrawals, no USD/share kinds. */
export function supportsClpCashMovements(schema: unknown): boolean {
  if (!supportsBrokerageMovements(schema)) return false;
  const kinds = schema.brokerage_flow_kinds as readonly string[];
  return (
    kinds.includes("savings_earnings") &&
    !kinds.includes("fx_exchange") &&
    !kinds.includes("stock_buy")
  );
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
