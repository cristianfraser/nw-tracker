import type { BookLedgerEditSchema } from "nw-tracker-contracts/dto/ledgerSchemas";

export type { BookLedgerEditSchema };

export function supportsBookLedgerEdit(schema: unknown): schema is BookLedgerEditSchema {
  if (typeof schema !== "object" || schema == null) return false;
  const s = schema as BookLedgerEditSchema;
  return s.valuations === true && s.movements?.units_delta === "optional";
}
