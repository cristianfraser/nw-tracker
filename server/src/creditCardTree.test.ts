import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { ccIssuerSlugForMasterAccount } from "./ccIssuerForAccount.js";
import { ccIssuerBySlug } from "./ccIssuers.js";
import {
  listCreditCardMasterAccountIds,
  listCreditCardMasterAccountIdsForIssuer,
  listCreditCardMasterAccountIdsInNavOrder,
} from "./creditCardTree.js";

describe("creditCardTree", () => {
  it("listCreditCardMasterAccountIds uses credit_cards asset group and drops superseded Santander cards", () => {
    const ids = listCreditCardMasterAccountIds();
    const notes = ids.map(
      (id) =>
        (db.prepare(`SELECT notes FROM accounts WHERE id = ?`).get(id) as { notes: string }).notes
    );
    expect(notes.every((n) => n.startsWith("credit_card_master|"))).toBe(true);
    expect(notes.some((n) => n.endsWith("|4112") || n.endsWith("|4111"))).toBe(false);
  });

  it("orders the masters by issuer and splits them by issuer", () => {
    const ordered = listCreditCardMasterAccountIdsInNavOrder();
    expect([...ordered].sort((a, b) => a - b)).toEqual([...listCreditCardMasterAccountIds()].sort((a, b) => a - b));
    const rank = ordered.map((id) => ccIssuerBySlug(ccIssuerSlugForMasterAccount(id))!.sort_order);
    expect(rank).toEqual([...rank].sort((a, b) => a - b));
    for (const id of listCreditCardMasterAccountIdsForIssuer("bci")) {
      expect(ccIssuerSlugForMasterAccount(id)).toBe("bci");
    }
  });
});
