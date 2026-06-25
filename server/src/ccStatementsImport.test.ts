import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  importCcStatementsMerge,
  type CcStatementCsvRecord,
} from "./ccStatementsImport.js";
import { getVitestSantanderCcMasterAccountId } from "./test/vitestDbSeed.js";

function row(overrides: Partial<CcStatementCsvRecord>): CcStatementCsvRecord {
  return {
    card_group: "A",
    source_pdf: "test-clp.pdf",
    statement_date: "01/06/2024",
    period_from: "21/05/2024",
    period_to: "20/06/2024",
    pay_by: "10/07/2024",
    card_last4: "4141",
    card_product: "",
    parser_layout: "compact",
    currency: "clp",
    statement_saldo_anterior: "1000",
    statement_abono: "0",
    statement_compras_cargos: "100",
    statement_deuda_total: "1100",
    statement_monto_facturado: "1100",
    transaction_date: "15/06",
    posting_date: "",
    place: "",
    merchant: "TEST CLP",
    description_merged: "TEST CLP",
    amount_orig: "",
    orig_currency: "",
    amount_clp: "100",
    amount_usd: "",
    installment_flag: "false",
    row_id: "1",
    raw_line: "",
    ...overrides,
  };
}

describe("importCcStatementsMerge CLP vs USD", () => {
  it("keeps separate statements for same close date when currency differs", () => {
    const accountId = getVitestSantanderCcMasterAccountId();
    if (accountId == null) return;
    db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id IN (
      SELECT id FROM cc_statements WHERE account_id = ?
    )`).run(accountId);
    db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);

    const clp = row({
      source_pdf: "2024-06-20 estado de cuenta tarjeta 4141.pdf",
      merchant: "CLP ONLY",
      row_id: "clp-1",
    });
    const usd = row({
      source_pdf: "2024-06-20 estado de cuenta tarjeta usd 4141.pdf",
      currency: "usd",
      parser_layout: "international_usd",
      merchant: "USD ONLY",
      amount_clp: "",
      amount_usd: "50.00",
      statement_monto_facturado: "50.00",
      row_id: "usd-1",
    });

    importCcStatementsMerge(accountId, [clp], { skipGlobalDedupeKeys: true });
    importCcStatementsMerge(accountId, [usd], { skipGlobalDedupeKeys: true });

    const stmts = db
      .prepare(
        `SELECT currency, source_pdf FROM cc_statements WHERE account_id = ? ORDER BY currency`
      )
      .all(accountId) as { currency: string; source_pdf: string }[];

    expect(stmts).toHaveLength(2);
    expect(stmts.map((s) => s.currency).sort()).toEqual(["clp", "usd"]);
    expect(stmts.find((s) => s.currency === "clp")?.source_pdf).toBe(
      "2024-06-20 estado de cuenta tarjeta 4141.pdf"
    );
    expect(stmts.find((s) => s.currency === "usd")?.source_pdf).toBe(
      "2024-06-20 estado de cuenta tarjeta usd 4141.pdf"
    );
  });
});

describe("importCcStatementsMerge fuzzy dedup", () => {
  it("skips re-import when merchant is truncated but date+amount+stem match (METLIFE case)", () => {
    const accountId = getVitestSantanderCcMasterAccountId();
    if (accountId == null) return;
    db.prepare(
      `DELETE FROM cc_statement_lines WHERE statement_id IN (SELECT id FROM cc_statements WHERE account_id = ?)`
    ).run(accountId);
    db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);

    const firstImport = row({
      merchant: "TOKU *METLIFE HIPOTE",
      amount_clp: "1795575",
      transaction_date: "11/06/2025",
      row_id: "met-1",
    });
    const secondImport = row({
      merchant: "TOKU *METLIFE HIPOTECAR,SANTIAGO",
      amount_clp: "1795575",
      transaction_date: "11/06/2025",
      row_id: "met-2",
    });

    const r1 = importCcStatementsMerge(accountId, [firstImport], { skipGlobalDedupeKeys: true });
    expect(r1.linesInserted).toBe(1);

    const r2 = importCcStatementsMerge(accountId, [secondImport], { skipGlobalDedupeKeys: true });
    expect(r2.linesInserted).toBe(0);
    expect(r2.linesSkippedFuzzyDuplicate).toBe(1);

    const count = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM cc_statement_lines l
           JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ?`
        )
        .get(accountId) as { n: number }
    ).n;
    expect(count).toBe(1);
  });
});
