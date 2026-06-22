/** Mirrors server `bookLedgerEditSchemaForAccount` on account summary / detail bundle. */
export type BookLedgerEditSchema = {
  valuations: true;
  movements: { units_delta: "optional" };
};

export function supportsBookLedgerEdit(schema: unknown): schema is BookLedgerEditSchema {
  if (typeof schema !== "object" || schema == null) return false;
  const s = schema as BookLedgerEditSchema;
  return s.valuations === true && s.movements?.units_delta === "optional";
}
