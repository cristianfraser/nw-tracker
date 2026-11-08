import { describe, expect, it } from "vitest";
import { readCaseFile } from "../formats/caseFile.js";
import { cardStatementLayout, storedCardLineDate, unpaddedCardLineDate } from "./canonicalLine.js";
import { canonicalLineFromParsedRow, canonicalStatementsFromParsedRecords } from "./parsedStatementRows.js";

type Cases = {
  parsed_rows: { name: string; statement_currency: "clp" | "usd"; row: Record<string, string>; line: Record<string, unknown> }[];
};
const cases = readCaseFile<Cases>("cardCanonicalLineCases.json");

describe("canonical card line: the parser's rows", () => {
  for (const c of cases.parsed_rows) {
    it(c.name, () => {
      expect(canonicalLineFromParsedRow(c.row, c.statement_currency)).toMatchObject(c.line);
    });
  }

  it("groups rows into statements in first-seen order, header from the rows", () => {
    const row = (over: Record<string, string>) => ({
      card_group: "A",
      source_pdf: "a.pdf",
      statement_date: "20/08/2026",
      period_from: "20/07/2026",
      period_to: "20/08/2026",
      transaction_date: "05/08/2026",
      merchant: "X",
      amount_clp: "1",
      installment_flag: "false",
      statement_monto_facturado: "1.234",
      statement_next_period_to: "1/9/2026",
      ...over,
    });
    const [a, b] = canonicalStatementsFromParsedRecords([row({}), row({ source_pdf: "b.pdf" }), row({ merchant: "Y" })]);
    expect(a!.document).toBe("a.pdf");
    expect(a!.lines.map((l) => l.merchant)).toEqual(["X", "Y"]);
    expect(b!.document).toBe("b.pdf");
    // One number style: Chilean («1.234» is a thousand two hundred thirty-four).
    expect(a!.header.monto_facturado).toBe(1234);
    expect(a!.header.next_period_to).toBe("01/09/2026");
  });

  it("refuses rows of one statement that disagree on its fields, and a line with both amounts", () => {
    const base = { card_group: "A", source_pdf: "a.pdf", statement_date: "20/08/2026", merchant: "X", amount_clp: "1" };
    expect(() => canonicalStatementsFromParsedRecords([base, { ...base, period_to: "21/08/2026" }])).toThrow(/disagree/);
    expect(() => canonicalStatementsFromParsedRecords([{ ...base, amount_usd: "1,00" }])).toThrow(/exactly one/);
    expect(() => canonicalStatementsFromParsedRecords([{ ...base, orig_currency: "usd" }])).toThrow(/labeled on import/);
  });

  it("stores a day as printed, else unpadded", () => {
    expect(storedCardLineDate("05/08/2026", "2026-08-05")).toBe("05/08/2026");
    expect(storedCardLineDate(null, "2026-08-05")).toBe("5/8/2026");
    expect(unpaddedCardLineDate("2026-12-31")).toBe("31/12/2026");
    expect(cardStatementLayout("wide_master_simple")).toBe("wide");
  });
});
