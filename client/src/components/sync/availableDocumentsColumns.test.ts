import { describe, expect, it } from "vitest";
import {
  availableDocumentsColumnsHaveSplit,
  buildAvailableDocumentsColumns,
} from "./availableDocumentsColumns";
import type { ImportSyncDocumentAccount } from "../../types";

describe("buildAvailableDocumentsColumns", () => {
  it("groups CLP+USD into one split column (usd then clp sub-columns)", () => {
    const accounts: ImportSyncDocumentAccount[] = [
      { account_id: 1, label: "Checking", document_kind: "checking_cartola" },
      {
        account_id: 35,
        label: "santander ·4141",
        document_kind: "cc_statement",
        cc_statement_currency: "clp",
      },
      {
        account_id: 35,
        label: "santander ·4141",
        document_kind: "cc_statement",
        cc_statement_currency: "usd",
      },
      { account_id: 42, label: "bci 4343", document_kind: "cc_statement" },
    ];
    const cols = buildAvailableDocumentsColumns(accounts);
    expect(cols).toHaveLength(3);
    expect(cols[0]).toMatchObject({ type: "single", accountIndex: 0 });
    expect(cols[1]).toMatchObject({
      type: "cc_split",
      accountId: 35,
      clpIndex: 1,
      usdIndex: 2,
    });
    expect(cols[2]).toMatchObject({ type: "single", accountIndex: 3 });
    expect(availableDocumentsColumnsHaveSplit(cols)).toBe(true);
  });

  it("keeps single column when card has no USD statements", () => {
    const accounts: ImportSyncDocumentAccount[] = [
      { account_id: 42, label: "bci 4343", document_kind: "cc_statement" },
    ];
    const cols = buildAvailableDocumentsColumns(accounts);
    expect(cols).toHaveLength(1);
    expect(cols[0]?.type).toBe("single");
    expect(availableDocumentsColumnsHaveSplit(cols)).toBe(false);
  });
});
