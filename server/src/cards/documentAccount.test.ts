import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cardAccountsForStatements, cardLast4OfStatement } from "./documentAccount.js";
import { resolveMasterAccountIdForCardLast4 } from "./config.js";
import { parsedStatements } from "../test/parsedStatementRecords.js";
import { createTempCardMaster, deleteTempCardMaster } from "../test/tempCardMaster.js";

/** A one-line parsed statement naming its plastic (or only its file name). */
function statement(card_last4: string, source_pdf: string) {
  return parsedStatements([
    { card_group: "A", source_pdf, statement_date: "20/08/2026", card_last4, merchant: "X", amount_clp: "1" },
  ])[0]!;
}

describe("cards/documentAccount", () => {
  // Masters for the registry fixture's plastics (test/ccCardsFixture.json: 4111 redirects to 4242).
  let id4141 = 0;
  let id4242 = 0;
  beforeAll(() => {
    id4141 = createTempCardMaster({ issuer: "santander", last4: "4141", key: "vitest-document-account-4141" });
    id4242 = createTempCardMaster({ issuer: "santander", last4: "4242", key: "vitest-document-account-4242" });
  });
  afterAll(() => {
    deleteTempCardMaster(id4141);
    deleteTempCardMaster(id4242);
  });

  it("reads the plastic from card_last4, else from the file name", () => {
    expect(cardLast4OfStatement(statement("4141", "other.pdf"))).toBe("4141");
    expect(cardLast4OfStatement(statement("", "2024-08-23 estado de cuenta tarjeta 4141.pdf"))).toBe("4141");
  });

  it("prefers card_last4 over trailing digits of a numeric filename", () => {
    // BCI Lider statements arrive named like `155028273.pdf`; the trailing `8273` is not the card.
    expect(cardLast4OfStatement(statement("4343", "155028273.pdf"))).toBe("4343");
  });

  it("routes statements to their masters", () => {
    expect(resolveMasterAccountIdForCardLast4("4141")).toBe(id4141);
    const { accountIds, unknownLast4, byAccount } = cardAccountsForStatements([
      statement("4141", "x.pdf"),
      statement("", "2024-01-24 estado de cuenta tarjeta 4141.pdf"),
    ]);
    expect(unknownLast4).toEqual([]);
    expect(accountIds).toContain(id4141);
    expect(byAccount.get(id4141)).toHaveLength(2);
  });

  it("follows the registry's consolidation redirect (4111 → 4242)", () => {
    const { accountIds } = cardAccountsForStatements([statement("4111", "2025-07-23 estado de cuenta tarjeta 4111.pdf")]);
    expect(accountIds).toEqual([id4242]);
  });

  it("filters by account-id when requested", () => {
    const { accountIds } = cardAccountsForStatements([statement("4141", "a.pdf"), statement("4242", "b.pdf")], {
      accountId: id4141,
    });
    expect(accountIds).toEqual([id4141]);
  });

  it("counts the lines of a plastic no master carries", () => {
    const { unknownLast4, linesUnknownCard } = cardAccountsForStatements([statement("0001", "z.pdf")]);
    expect(unknownLast4).toEqual(["0001"]);
    expect(linesUnknownCard).toBe(1);
  });
});
