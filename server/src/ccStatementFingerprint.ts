/**
 * Incremental statement import: skip statements whose parsed content is byte-for-byte what was
 * imported last time.
 *
 * The nightly job feeds the WHOLE merged CSV to the importer, which re-imports and — more
 * expensively — re-reconciles every statement in history. That made one unresolvable legacy
 * statement abort the entire import every night, and put ~240 statements through the reconcile
 * to discover that ~239 of them had not changed.
 *
 * A statement's fingerprint is a hash of the exact CSV records it would import from. The parser
 * derives `row_id` from `source_pdf` + row index + raw line, so an unchanged parse produces
 * identical records and therefore an identical fingerprint; anything that changes the parse (a
 * parser fix, a re-downloaded PDF, a new line) changes it and the statement re-imports with the
 * full reconcile. A new CSV column also changes every fingerprint, which is correct: the parser
 * changed, so everything is worth re-validating once.
 *
 * The gate is only ever a *skip* — it never weakens the reconcile for a statement that does
 * import, and `--full` bypasses it entirely for a from-scratch reconciliation.
 */
import crypto from "node:crypto";
import { db } from "./db.js";

/**
 * Structurally the parser's CSV record. Declared locally rather than imported from
 * `ccStatementsImport` because that module needs the fingerprint helper — importing the type
 * back would make the two mutually dependent at module-init time.
 */
export type CcStatementFingerprintRecord = Record<string, string>;

/** Mirror of `statementKeyFromRow`; kept here so this module stays a leaf. */
export function statementKeyFromRecord(row: CcStatementFingerprintRecord): string {
  return `${row.card_group ?? "A"}\t${row.source_pdf ?? ""}\t${row.statement_date ?? ""}`;
}

/**
 * Deterministic hash of one statement's records.
 *
 * Rows are sorted by their stable `row_id` (falling back to the serialized record) so CSV
 * ordering cannot alter the result, and every field is included rather than a chosen subset —
 * picking fields would silently ignore a parser change in whatever was left out.
 */
export function ccStatementRecordsFingerprint(records: readonly CcStatementFingerprintRecord[]): string {
  const serialized = records
    .map((rec) => {
      const keys = Object.keys(rec).sort();
      return JSON.stringify(keys.map((k) => [k, String(rec[k] ?? "")]));
    })
    .sort();
  const h = crypto.createHash("sha256");
  for (const line of serialized) h.update(line).update("\n");
  return h.digest("hex").slice(0, 32);
}

/** Group records the same way the importer does: one bucket per statement. */
export function groupRecordsByStatement(
  records: readonly CcStatementFingerprintRecord[]
): Map<string, CcStatementFingerprintRecord[]> {
  const byStmt = new Map<string, CcStatementFingerprintRecord[]>();
  for (const rec of records) {
    const key = statementKeyFromRecord(rec);
    const list = byStmt.get(key) ?? [];
    list.push(rec);
    byStmt.set(key, list);
  }
  return byStmt;
}

const selFingerprint = db.prepare(
  `SELECT import_fingerprint AS fp FROM cc_statements
   WHERE account_id = ? AND card_group = ? AND source_pdf = ? AND statement_date = ?`
);

/**
 * Same fallback the importer uses when the source_pdf does not match: a re-downloaded statement
 * arrives under a new filename but fills the SAME facturación slot, so the existing row is
 * updated rather than duplicated. The fingerprint check has to resolve the row the same way, or
 * such a statement re-imports on every run forever (observed on the BCI ·0101 pair whose
 * `-27` filenames were superseded by `-26` ones).
 */
const selFingerprintByClose = db.prepare(
  `SELECT import_fingerprint AS fp FROM cc_statements
   WHERE account_id = ? AND card_group = ? AND statement_date = ?
   ORDER BY id DESC LIMIT 1`
);

/** `card_group\tsource_pdf\tstatement_date` — the shape `statementKeyFromRecord` produces. */
function splitStatementKey(key: string): { cardGroup: string; sourcePdf: string; statementDate: string } {
  const [cardGroup = "", sourcePdf = "", statementDate = ""] = key.split("\t");
  return { cardGroup, sourcePdf, statementDate };
}

export type CcIncrementalFilterResult = {
  /** Records for statements that are new or whose parse changed — import these. */
  changed: CcStatementFingerprintRecord[];
  /** Statement keys skipped because their fingerprint matched what is already imported. */
  skippedKeys: string[];
  /** Fingerprint per statement key, for storing after a successful import. */
  fingerprintByKey: Map<string, string>;
};

/**
 * Split an account's records into "needs importing" and "unchanged since last import".
 *
 * A statement with no stored fingerprint is always treated as changed, so the first run after
 * this lands imports everything once and records the baseline. Web-paste buckets are never
 * skipped: they are provisional and get rewritten by their own repair/supersede logic.
 */
export function filterUnchangedStatementRecords(
  accountId: number,
  records: readonly CcStatementFingerprintRecord[]
): CcIncrementalFilterResult {
  const byStmt = groupRecordsByStatement(records);
  const changed: CcStatementFingerprintRecord[] = [];
  const skippedKeys: string[] = [];
  const fingerprintByKey = new Map<string, string>();

  for (const [key, stmtRecords] of byStmt) {
    const { cardGroup, sourcePdf, statementDate } = splitStatementKey(key);
    const fingerprint = ccStatementRecordsFingerprint(stmtRecords);
    fingerprintByKey.set(key, fingerprint);

    if (sourcePdf.startsWith("import:web-paste")) {
      changed.push(...stmtRecords);
      continue;
    }
    const row = (selFingerprint.get(accountId, cardGroup, sourcePdf, statementDate) ??
      selFingerprintByClose.get(accountId, cardGroup, statementDate)) as
      | { fp: string | null }
      | undefined;
    if (row && row.fp && row.fp === fingerprint) {
      skippedKeys.push(key);
      continue;
    }
    changed.push(...stmtRecords);
  }

  return { changed, skippedKeys, fingerprintByKey };
}
