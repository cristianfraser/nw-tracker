import { afterAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  importCcStatementsMerge,
  type CcStatementCsvRecord,
} from "./ccStatementsImport.js";
import { overrideFxDaily } from "./test/fxDailyFixture.js";
import { getVitestSantanderCcMasterAccountId, wipeVitestCcFixtureData } from "./test/vitestDbSeed.js";

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

describe("importCcStatementsMerge vs open web-paste bucket", () => {
  // Regression for the 2026-08 ·0101 facturación: 9 statement rows were skipped as
  // duplicates of open web-paste bucket lines, and the merge's supersede then deleted
  // those bucket lines — the purchases vanished from both places. A PDF import must
  // never count web-paste lines as existing evidence.
  function wipe(accountId: number): void {
    db.prepare(
      `DELETE FROM cc_statement_lines WHERE statement_id IN (SELECT id FROM cc_statements WHERE account_id = ?)`
    ).run(accountId);
    db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);
  }

  it("imports the PDF row over a fuzzy web-paste twin (truncated merchant)", () => {
    const accountId = getVitestSantanderCcMasterAccountId();
    if (accountId == null) return;
    wipe(accountId);

    const paste = row({
      source_pdf: "import:web-paste|open|2025-06",
      statement_date: "20/06/2025",
      merchant: "TOKU *METLIFE HIPOTE",
      amount_clp: "753333",
      transaction_date: "11/06/2025",
      statement_monto_facturado: "",
      row_id: "wp-fuzzy-1",
    });
    const rPaste = importCcStatementsMerge(accountId, [paste], { skipGlobalDedupeKeys: true });
    expect(rPaste.linesInserted).toBe(1);

    const pdf = row({
      source_pdf: "2025-06-23 estado de cuenta tarjeta 4141.pdf",
      statement_date: "23/06/2025",
      merchant: "TOKU *METLIFE HIPOTECAR,SANTIAGO",
      amount_clp: "753333",
      transaction_date: "11/06/2025",
      row_id: "pdf-fuzzy-1",
    });
    const rPdf = importCcStatementsMerge(accountId, [pdf], { skipGlobalDedupeKeys: true });
    expect(rPdf.linesSkippedFuzzyDuplicate).toBe(0);
    expect(rPdf.linesInserted).toBe(1);
  });

  it("imports the PDF row over an identical-key web-paste twin", () => {
    const accountId = getVitestSantanderCcMasterAccountId();
    if (accountId == null) return;
    wipe(accountId);

    const paste = row({
      source_pdf: "import:web-paste|open|2025-06",
      statement_date: "20/06/2025",
      merchant: "EXPRESS LYON, SANTIAGO",
      amount_clp: "19310",
      transaction_date: "06/06/2025",
      statement_monto_facturado: "",
      row_id: "wp-key-1",
    });
    importCcStatementsMerge(accountId, [paste], { skipGlobalDedupeKeys: true });

    const pdf = row({
      source_pdf: "2025-06-23 estado de cuenta tarjeta 4141.pdf",
      statement_date: "23/06/2025",
      merchant: "EXPRESS LYON, SANTIAGO",
      amount_clp: "19310",
      transaction_date: "06/06/2025",
      row_id: "pdf-key-1",
    });
    const rPdf = importCcStatementsMerge(accountId, [pdf], { skipGlobalDedupeKeys: true });
    expect(rPdf.linesSkippedDuplicate).toBe(0);
    expect(rPdf.linesInserted).toBe(1);
  });

  it("web-paste imports still dedupe against PDF statement lines (reverse direction)", () => {
    const accountId = getVitestSantanderCcMasterAccountId();
    if (accountId == null) return;
    wipe(accountId);

    const pdf = row({
      source_pdf: "2025-06-23 estado de cuenta tarjeta 4141.pdf",
      statement_date: "23/06/2025",
      merchant: "EXPRESS LYON, SANTIAGO",
      amount_clp: "19310",
      transaction_date: "06/06/2025",
      row_id: "pdf-rev-1",
    });
    importCcStatementsMerge(accountId, [pdf], { skipGlobalDedupeKeys: true });

    const paste = row({
      source_pdf: "import:web-paste|open|2025-06",
      statement_date: "20/06/2025",
      merchant: "EXPRESS LYON, SANTIAGO",
      amount_clp: "19310",
      transaction_date: "06/06/2025",
      statement_monto_facturado: "",
      row_id: "wp-rev-1",
    });
    const rPaste = importCcStatementsMerge(accountId, [paste], { skipGlobalDedupeKeys: true });
    expect(rPaste.linesInserted).toBe(0);
    expect(rPaste.linesSkippedDuplicate).toBe(1);
  });
});

describe("importCcStatementsMerge origin currency", () => {
  // The parser writes MONTO MONEDA ORIGEN as printed and never a currency; the import labels it.
  const usdLine = (overrides: Partial<CcStatementCsvRecord>): CcStatementCsvRecord =>
    row({
      source_pdf: "2031-03-20 estado de cuenta tarjeta usd 4141.pdf",
      statement_date: "20/03/2031",
      currency: "usd",
      parser_layout: "international_usd",
      transaction_date: "14/03/2031",
      amount_clp: "",
      statement_monto_facturado: "",
      ...overrides,
    });

  it("stores the printed origin and labels it from the amounts and the day's fx", () => {
    const accountId = getVitestSantanderCcMasterAccountId();
    if (accountId == null) return;
    db.prepare(
      `DELETE FROM cc_statement_lines WHERE statement_id IN (SELECT id FROM cc_statements WHERE account_id = ?)`
    ).run(accountId);
    db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);
    const restoreFx = overrideFxDaily([["2031-03-14", 950]]);
    try {
      importCcStatementsMerge(
        accountId,
        [
          // Pesos from a GB-coded merchant: the old reader stored 18,25 and called it pounds.
          usdLine({ merchant: "TIENDA PESOS", country: "GB", amount_orig: "18.250,00", amount_usd: "19,21", row_id: "o-1" }),
          usdLine({ merchant: "TIENDA DOLARES", country: "US", amount_orig: "4,25", amount_usd: "4,25", row_id: "o-2" }),
          usdLine({ merchant: "TIENDA REALES", country: "BR", amount_orig: "15,00", amount_usd: "2,90", row_id: "o-3" }),
          usdLine({ merchant: "ABONO DE DIVISAS", country: "CH", amount_orig: "0,00", amount_usd: "-30,00", row_id: "o-4" }),
        ],
        { skipGlobalDedupeKeys: true }
      );
    } finally {
      restoreFx();
    }
    const stored = db
      .prepare(
        `SELECT l.merchant, l.amount_orig, l.orig_currency FROM cc_statement_lines l
         JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ? ORDER BY l.id`
      )
      .all(accountId);
    expect(stored).toEqual([
      { merchant: "TIENDA PESOS", amount_orig: 18250, orig_currency: "clp" },
      { merchant: "TIENDA DOLARES", amount_orig: 4.25, orig_currency: "usd" },
      { merchant: "TIENDA REALES", amount_orig: 15, orig_currency: null },
      { merchant: "ABONO DE DIVISAS", amount_orig: 0, orig_currency: null },
    ]);
  });

  it("refuses a record that carries a currency label (a producer older than the rule)", () => {
    const accountId = getVitestSantanderCcMasterAccountId();
    if (accountId == null) return;
    expect(() =>
      importCcStatementsMerge(
        accountId,
        [usdLine({ merchant: "CON ETIQUETA", amount_orig: "5,00", amount_usd: "4,95", orig_currency: "CLP", row_id: "o-5" })],
        { skipGlobalDedupeKeys: true }
      )
    ).toThrow(/labeled on import/);
  });
});

afterAll(() => {
  wipeVitestCcFixtureData();
});
