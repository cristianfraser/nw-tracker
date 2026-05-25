import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { listCreditCardGroupMasterAccountIds, listCreditCardMasterAccountIds } from "./creditCardTree.js";

describe("creditCardTree", () => {
  it("listCreditCardMasterAccountIds uses credit_cards asset group and drops superseded Santander cards", () => {
    const ids = listCreditCardMasterAccountIds();
    const notes = ids.map(
      (id) =>
        (db.prepare(`SELECT notes FROM accounts WHERE id = ?`).get(id) as { notes: string }).notes
    );
    expect(notes.every((n) => n.startsWith("credit_card_master|"))).toBe(true);
    expect(notes.some((n) => n.endsWith("|4112") || n.endsWith("|4111"))).toBe(false);

    const santander = listCreditCardGroupMasterAccountIds("santander");
    const bci = listCreditCardGroupMasterAccountIds("bci");
    for (const id of [...santander, ...bci]) {
      if (notes.some((n) => n.includes("|4112") || n.includes("|4111"))) continue;
      expect(ids).toContain(id);
    }
  });
});
