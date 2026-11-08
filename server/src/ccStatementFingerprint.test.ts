import { afterEach, describe, expect, it } from "vitest";
import { cardStatementKey } from "nw-tracker-contracts";
import { filterUnchangedStatements } from "./ccStatementFingerprint.js";
import { cardStatementFingerprint } from "./cards/statementStorage.js";
import { db } from "./db.js";
import { parsedStatements, type ParsedRecord } from "./test/parsedStatementRecords.js";

const fingerprint = (records: ParsedRecord[]) => cardStatementFingerprint(parsedStatements(records)[0]!);

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

  function rec(over: Partial<ParsedRecord> = {}): ParsedRecord {
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

    // Line order must not change the fingerprint.
    expect(fingerprint([a, b])).toBe(fingerprint([b, a]));
    // Any content change must.
    expect(fingerprint([a])).not.toBe(fingerprint([rec({ amount_clp: "10001" })]));
    // A dropped line must, too — this is the case the old parser bug produced.
    expect(fingerprint([a, b])).not.toBe(fingerprint([a]));
    // A header the statement prints differently must.
    expect(fingerprint([a])).not.toBe(fingerprint([rec({ statement_monto_facturado: "10000" })]));
  });

  it("hashes what is stored, not how a source printed it", () => {
    // The same dollars written «13,77» by the parser and carried as 13.77 by another source.
    const usd = rec({ currency: "usd", parser_layout: "international_usd", amount_clp: "", amount_usd: "13,77" });
    const st = parsedStatements([usd])[0]!;
    expect(st.lines[0]!.amount).toBe(13.77);
    // The document key and the identity columns the row is resolved by stay out.
    expect(fingerprint([usd])).toBe(fingerprint([{ ...usd, dedupe_key: "another-key" }]));
    expect(fingerprint([usd])).toBe(fingerprint([{ ...usd, source_pdf: "vitest-fp-redownload.pdf" }]));
  });

  it("leaves out a line the import drops as a repeat within the statement", () => {
    const a = rec();
    expect(fingerprint([a, { ...a }])).toBe(fingerprint([a]));
    // A same-statement twin (a fresh document key) is a line of its own.
    expect(fingerprint([a, { ...a, row_id: "row-2", dedupe_key: "dk-2" }])).not.toBe(fingerprint([a]));
  });

  it("skips a statement whose fingerprint matches and imports one that changed", () => {
    const accountId = fixtureAccountId();
    const records = [rec(), rec({ row_id: "row-2", dedupe_key: "dk-2", merchant: "FARMACIA" })];
    seedStatement(accountId, fingerprint(records));

    const unchanged = filterUnchangedStatements(accountId, parsedStatements(records));
    expect(unchanged.changed).toHaveLength(0);
    expect(unchanged.skippedKeys).toEqual([cardStatementKey(parsedStatements(records)[0]!)]);

    // One extra line — the statement must go through the full import + reconcile again.
    const withExtra = [...records, rec({ row_id: "row-3", dedupe_key: "dk-3", amount_clp: "777" })];
    const changed = filterUnchangedStatements(accountId, parsedStatements(withExtra));
    expect(changed.changed).toHaveLength(1);
    expect(changed.changed[0]!.lines).toHaveLength(3);
    expect(changed.skippedKeys).toEqual([]);
  });

  it("treats a never-fingerprinted statement as changed, then settles once stored", () => {
    const accountId = fixtureAccountId();
    const statements = parsedStatements([rec()]);
    seedStatement(accountId, null); // pre-existing row from before this feature

    const first = filterUnchangedStatements(accountId, statements);
    expect(first.changed).toHaveLength(1);

    // The importer writes the fingerprint onto the row it resolved (see ccStatementsImport).
    db.prepare(`UPDATE cc_statements SET import_fingerprint = ? WHERE id = ?`).run(
      cardStatementFingerprint(statements[0]!),
      created[created.length - 1]!
    );

    const second = filterUnchangedStatements(accountId, statements);
    expect(second.changed).toHaveLength(0);
    expect(second.skippedKeys).toEqual([cardStatementKey(statements[0]!)]);
  });

  it("never skips a web-paste bucket", () => {
    const accountId = fixtureAccountId();
    const records = [rec({ source_pdf: "import:web-paste|open|2026-08" })];
    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency, import_fingerprint)
       VALUES (?, 'vitest-fp', 'import:web-paste|open|2026-08', '20/08/2026', '20/07/2026', '20/08/2026', 'clp', ?)`
    ).run(accountId, fingerprint(records));
    created.push((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);

    const result = filterUnchangedStatements(accountId, parsedStatements(records));
    expect(result.changed).toHaveLength(1);
    expect(result.skippedKeys).toEqual([]);
  });
});
