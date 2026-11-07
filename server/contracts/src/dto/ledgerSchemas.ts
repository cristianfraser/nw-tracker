/** Server `bookLedgerEditSchemaForAccount` on the account summary / detail bundle. */
export type BookLedgerEditSchema = {
  valuations: true;
  movements: { units_delta: "optional" };
};

/** Server `movementCreateSchemaForAccount` on the account summary / detail bundle. */
export type MovementCreateSchema = {
  ledger: "movements";
  units_delta: "required" | "optional";
  unit_label: string;
  brokerage_flow_kinds?: readonly string[];
  units_required_for_flow_kinds?: readonly string[];
};
