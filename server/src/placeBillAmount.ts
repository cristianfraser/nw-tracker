/**
 * A place bill's amount: an `expense_entries` row with a place (`expense_account_id` set) is in
 * pesos — a CHECK of migration 316 holds it, and every bill reader (the purchase matchers, the
 * real-estate page, «Próximos pagos», the rental tax facts) compares it with a purchase's pesos.
 * The readers select {@link placeBillPesosSql} and refuse a row it leaves NULL
 * ({@link requirePlaceBillPesos}): a bill in another currency is a data error, never read as pesos.
 */

/** SQL: the bill's pesos, NULL when the row is in another currency (alias `a` for `expense_entries`). */
export function placeBillPesosSql(a: string): string {
  return `(CASE WHEN ${a}.currency = 'clp' THEN ${a}.amount END)`;
}

/** The bill's pesos as {@link placeBillPesosSql} read them; throws on a bill not in pesos. */
export function requirePlaceBillPesos(entryId: number, pesos: number | null): number {
  if (pesos == null) throw new Error(`place bill ${entryId} is not in pesos (expense_entries.currency)`);
  return pesos;
}
