import { describe, expect, it } from "vitest";
import { parsedStatements } from "../test/parsedStatementRecords.js";
import { assertStoredCardLineDates, cardStatementFingerprint, storedLineColumns } from "./statementStorage.js";

const record = (transaction_date: string) => ({
  card_group: "santander",
  source_pdf: "vitest-storage.pdf",
  statement_date: "20/08/2026",
  period_from: "21/07/2026",
  period_to: "20/08/2026",
  parser_layout: "compact",
  installment_flag: "false",
  transaction_date,
  merchant: "VITEST STORAGE",
  amount_clp: "1000",
  row_id: "vitest-storage-1",
  dedupe_key: "vitest-storage-1",
});

describe("card line days as stored", () => {
  it("stores the day padded whatever the document printed, and fingerprints the printed text", () => {
    const [short] = parsedStatements([record("5/8/2026")]);
    const [padded] = parsedStatements([record("05/08/26")]);
    expect(storedLineColumns(short!, short!.lines[0]!).transaction_date).toBe("05/08/2026");
    expect(storedLineColumns(padded!, padded!.lines[0]!).transaction_date).toBe("05/08/2026");
    // The fingerprint keeps hashing the document's own text (the shape stored before migration 369).
    expect(cardStatementFingerprint(short!)).not.toBe(cardStatementFingerprint(padded!));
  });

  it("the write funnel refuses a day in any other shape", () => {
    expect(() => assertStoredCardLineDates({ transaction_date: "05/08/2026", posting_date: null }, "t")).not.toThrow();
    expect(() => assertStoredCardLineDates({ transaction_date: "5/8/2026", posting_date: null }, "t")).toThrow(/transaction_date «5\/8\/2026»/);
    expect(() => assertStoredCardLineDates({ transaction_date: null, posting_date: "05/08/26" }, "t")).toThrow(/posting_date/);
    expect(() => assertStoredCardLineDates({ transaction_date: "32/08/2026", posting_date: null }, "t")).toThrow();
  });

  it("refuses a printed day the parser row cannot read", () => {
    expect(() => parsedStatements([record("13/05/2511001SANTIAG")])).toThrow(/transaction_date «13\/05\/2511001SANTIAG» is not a date/);
  });
});
