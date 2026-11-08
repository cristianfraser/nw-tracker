import { readCaseFile } from "nw-tracker-contracts";
import { canonicalLineFromParsedRow, type CardListingLine, type CardStatementLine } from "nw-tracker-contracts";
import { describe, expect, it } from "vitest";
import { listingLineFromCardListingLine } from "./cardListingLines.js";
import { listingLineStoredAmount, webPasteLinesFromPastedListing } from "./ccWebPasteParse.js";
import { buildSantanderStatement } from "./santanderStatementImport.js";

/** Each card source's conversion into the canonical card line (`cardCanonicalLineCases.json`). */
type Cases = {
  parsed_rows: { name: string; statement_currency: "clp" | "usd"; row: Record<string, string>; line: Record<string, unknown> }[];
  listing: { name: string; line: CardListingLine; stored_amount: number }[];
  paste: { name: string; card_group: string; merchant: string; currency: "clp" | "usd"; pasted: number; stored_amount: number }[];
  statement_json: { name: string; currency: "clp" | "usd"; line: CardStatementLine; canonical: Record<string, unknown> }[];
};
const cases = readCaseFile<Cases>("cardCanonicalLineCases.json");

describe("canonical card line, per source", () => {
  for (const c of cases.parsed_rows) {
    it(`parser row: ${c.name}`, () => expect(canonicalLineFromParsedRow(c.row, c.statement_currency)).toMatchObject(c.line));
  }
  for (const c of cases.listing) {
    it(`listing: ${c.name}`, () => {
      const line = listingLineFromCardListingLine(c.line);
      expect(line.amount).toBe(c.line.amount);
      expect(listingLineStoredAmount(line)).toBe(c.stored_amount);
    });
  }
  for (const c of cases.paste) {
    it(`paste: ${c.name}`, () => {
      const { lines } = webPasteLinesFromPastedListing(
        { lines: [{ date: "2026-11-06", merchant: c.merchant, amount: c.pasted, currency: c.currency, raw_line: "r" }], errors: [] },
        c.card_group
      );
      expect(listingLineStoredAmount(lines[0]!)).toBe(c.stored_amount);
    });
  }
  for (const c of cases.statement_json) {
    it(`statement JSON: ${c.name}`, () => {
      const statement = buildSantanderStatement(c.currency, [c.line], null, {
        accountId: 0,
        statementDate: "20/09/2026",
        cardGroup: "vitest",
        periodFrom: "20/08/2026",
        payBy: null,
        cardLast4: null,
      });
      expect(statement.lines[0]).toMatchObject(c.canonical);
    });
  }
});
