import { afterEach, describe, expect, it } from "vitest";
import {
  ccStatementRecordsFingerprint,
  filterUnchangedStatementRecords,
  groupRecordsByStatement,
} from "./ccStatementFingerprint.js";
import type { CcStatementCsvRecord } from "./ccStatementsImport.js";
import { statementKeyFromRow } from "./ccStatementsImport.js";
import { db } from "./db.js";

/**
 * Incremental import: the nightly job must stop re-importing and re-reconciling ~240 unchanged
 * historical statements, without ever weakening the checks for one that did change.
 */
describe("ccStatementFingerprint", () => {
  const created: number[] = [];

  afterEach(() => {
    for (const id of created.splice(0)) {
      db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(id);
      db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(id);
    }
  });

  function rec(over: Partial<CcStatementCsvRecord> = {}): CcStatementCsvRecord {
    return {
      card_group: "vitest-fp",
      source_pdf: "vitest-fp.pdf",
      statement_date: "20/08/2026",
      period_from: "20/07/2026",
      period_to: "20/08/2026",
      currency: "clp",
      parser_layout: "compact",
      installment_flag: "false",
      transaction_date: "5/8/2026",
      merchant: "SUPERMERCADO",
      amount_clp: "10000",
      row_id: "row-1",
      dedupe_key: "dk-1",
      ...over,
    };
  }

  /** A real account id — cc_statements.account_id is a foreign key. */
  function fixtureAccountId(): number {
    const row = db
      .prepare(`SELECT id FROM accounts WHERE notes LIKE 'credit_card_master|%' ORDER BY id LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!row) throw new Error("no credit-card master in the test DB");
    return row.id;
  }

  function seedStatement(accountId: number, fingerprint: string | null): number {
    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency, import_fingerprint)
       VALUES (?, 'vitest-fp', 'vitest-fp.pdf', '20/08/2026', '20/07/2026', '20/08/2026', 'clp', ?)`
    ).run(accountId, fingerprint);
    const id = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    created.push(id);
    return id;
  }

  it("is order-independent and content-sensitive", () => {
    const a = rec({ row_id: "row-1", dedupe_key: "dk-1" });
    const b = rec({ row_id: "row-2", dedupe_key: "dk-2", merchant: "FARMACIA", amount_clp: "2500" });

    // CSV ordering must not change the fingerprint.
    expect(ccStatementRecordsFingerprint([a, b])).toBe(ccStatementRecordsFingerprint([b, a]));
    // Any content change must.
    expect(ccStatementRecordsFingerprint([a])).not.toBe(
      ccStatementRecordsFingerprint([rec({ amount_clp: "10001" })])
    );
    // A dropped line must, too — this is the case the old parser bug produced.
    expect(ccStatementRecordsFingerprint([a, b])).not.toBe(ccStatementRecordsFingerprint([a]));
    // A brand-new CSV column changes it: the parser changed, so re-validate once.
    expect(ccStatementRecordsFingerprint([a])).not.toBe(
      ccStatementRecordsFingerprint([{ ...a, brand_new_column: "x" } as CcStatementCsvRecord])
    );
  });

  it("groups records per statement", () => {
    const other = rec({ source_pdf: "vitest-fp-2.pdf", row_id: "row-9" });
    const grouped = groupRecordsByStatement([rec(), rec({ row_id: "row-2" }), other]);
    expect(grouped.size).toBe(2);
    expect(grouped.get(statementKeyFromRow(rec()))).toHaveLength(2);
  });

  it("skips a statement whose fingerprint matches and imports one that changed", () => {
    const accountId = fixtureAccountId();
    const records = [rec(), rec({ row_id: "row-2", dedupe_key: "dk-2", merchant: "FARMACIA" })];
    const fp = ccStatementRecordsFingerprint(records);
    seedStatement(accountId, fp);

    const unchanged = filterUnchangedStatementRecords(accountId, records);
    expect(unchanged.changed).toHaveLength(0);
    expect(unchanged.skippedKeys).toEqual([statementKeyFromRow(records[0]!)]);

    // One extra line — the statement must go through the full import + reconcile again.
    const withExtra = [...records, rec({ row_id: "row-3", dedupe_key: "dk-3", amount_clp: "777" })];
    const changed = filterUnchangedStatementRecords(accountId, withExtra);
    expect(changed.changed).toHaveLength(3);
    expect(changed.skippedKeys).toEqual([]);
  });

  it("treats a never-fingerprinted statement as changed, then settles once stored", () => {
    const accountId = fixtureAccountId();
    const records = [rec()];
    seedStatement(accountId, null); // pre-existing row from before this feature

    const first = filterUnchangedStatementRecords(accountId, records);
    expect(first.changed).toHaveLength(1);

    // The importer writes the fingerprint onto the row it resolved (see ccStatementsImport).
    const key = statementKeyFromRow(records[0]!);
    db.prepare(`UPDATE cc_statements SET import_fingerprint = ? WHERE id = ?`).run(
      first.fingerprintByKey.get(key)!,
      created[created.length - 1]!
    );

    const second = filterUnchangedStatementRecords(accountId, records);
    expect(second.changed).toHaveLength(0);
    expect(second.skippedKeys).toEqual([key]);
  });

  it("never skips a web-paste bucket", () => {
    const accountId = fixtureAccountId();
    const records = [rec({ source_pdf: "import:web-paste|open|2026-08" })];
    const fp = ccStatementRecordsFingerprint(records);
    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency, import_fingerprint)
       VALUES (?, 'vitest-fp', 'import:web-paste|open|2026-08', '20/08/2026', '20/07/2026', '20/08/2026', 'clp', ?)`
    ).run(accountId, fp);
    created.push((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);

    const result = filterUnchangedStatementRecords(accountId, records);
    expect(result.changed).toHaveLength(1);
    expect(result.skippedKeys).toEqual([]);
  });
});
