import { describe, expect, it } from "vitest";
import { CARD_PARSED_STATEMENT_COLUMNS } from "nw-tracker-contracts";
import { applyParsedCcStatements } from "./ccParsedStatementsApply.js";
import { db } from "./db.js";

function record(over: Record<string, string>): Record<string, string> {
  return { ...Object.fromEntries(CARD_PARSED_STATEMENT_COLUMNS.map((c) => [c, ""])), ...over };
}

describe("applyParsedCcStatements", () => {
  it("writes nothing when a line names a card no account takes", () => {
    const before = (db.prepare(`SELECT COUNT(*) AS n FROM cc_statements`).get() as { n: number }).n;
    const details = applyParsedCcStatements(
      [record({ card_last4: "9876", source_pdf: "vitest unknown card 9876.pdf", statement_date: "20/09/2030", merchant: "X", amount_clp: "1000" })],
      { dryRun: false, full: false }
    );
    expect(details.applied).toBe(false);
    expect(details.problems[0]).toMatch(/no card account takes any line.*\(unknown: 9876\)/);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM cc_statements`).get() as { n: number }).n).toBe(before);
  });
});
