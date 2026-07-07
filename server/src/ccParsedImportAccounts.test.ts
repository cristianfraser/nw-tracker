import { describe, expect, it } from "vitest";
import {
  cardLast4FromParsedRow,
  discoverMasterAccountIdsFromParsedRows,
  resolveImportAccountIds,
} from "./ccParsedImportAccounts.js";
import { resolveMasterAccountIdForCardLast4 } from "./creditCardTree.js";

describe("ccParsedImportAccounts", () => {
  it("reads last4 from card_last4 or source_pdf", () => {
    expect(
      cardLast4FromParsedRow({
        card_last4: "4141",
        source_pdf: "other.pdf",
      })
    ).toBe("4141");
    expect(
      cardLast4FromParsedRow({
        card_last4: "",
        source_pdf: "2024-08-23 estado de cuenta tarjeta 4141.pdf",
      })
    ).toBe("4141");
  });

  it("prefers card_last4 over trailing digits of a numeric filename", () => {
    // BCI Lider statements arrive named like `155028273.pdf`; the trailing
    // `8273` is not the card. The PDF-upload path must match on card_last4.
    expect(
      cardLast4FromParsedRow({
        card_last4: "4343",
        source_pdf: "155028273.pdf",
      })
    ).toBe("4343");
  });

  it("discovers master accounts from parsed rows", () => {
    const id4141 = resolveMasterAccountIdForCardLast4("4141");
    if (id4141 == null) return;

    const { accountIds, unknownLast4 } = discoverMasterAccountIdsFromParsedRows([
      { card_last4: "4141", source_pdf: "x.pdf" },
      { card_last4: "", source_pdf: "2024-01-24 estado de cuenta tarjeta 4141.pdf" },
    ]);
    expect(unknownLast4).toEqual([]);
    expect(accountIds).toContain(id4141);
  });

  it("redirects 4111 imports to 4242 master", () => {
    const id4242 = resolveMasterAccountIdForCardLast4("4242");
    if (id4242 == null) return;

    const { accountIds } = discoverMasterAccountIdsFromParsedRows([
      { card_last4: "4111", source_pdf: "2025-07-23 estado de cuenta tarjeta 4111.pdf" },
    ]);
    expect(accountIds).toEqual([id4242]);
  });

  it("filters by account-id when requested", () => {
    const id4141 = resolveMasterAccountIdForCardLast4("4141");
    const id4242 = resolveMasterAccountIdForCardLast4("4242");
    if (id4141 == null || id4242 == null) return;

    const records = [
      { card_last4: "4141", source_pdf: "a.pdf" },
      { card_last4: "4242", source_pdf: "b.pdf" },
    ];
    const { accountIds } = resolveImportAccountIds({
      records,
      accountId: id4141,
    });
    expect(accountIds).toEqual([id4141]);
  });
});
