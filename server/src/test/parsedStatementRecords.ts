import { canonicalStatementsFromParsedRecords, type CardCanonicalStatement } from "nw-tracker-contracts";

/** A statement parser CSV row (`cc-statements-parsed-all.csv`), column → cell. */
export type ParsedRecord = Record<string, string>;

/** Parser rows → canonical statements, as every parser source is read (`parsedStatementRows.ts`). */
export function parsedStatements(records: readonly ParsedRecord[]): CardCanonicalStatement[] {
  return canonicalStatementsFromParsedRecords(records);
}
