import { describe, expect, it } from "vitest";
import { listCreditCardMasterAccountIdsInNavOrder } from "./creditCardTree.js";
import { getLiabilitiesNavChildren } from "./liabilityTree.js";
import { listLiabilitiesTabAccountRows } from "./liabilityTabAccounts.js";
import { db } from "./db.js";
import { updateLiabilityGroupColorRgb } from "./entityColors.js";
import { colorRgbOfLargestBalanceAccount } from "./chartColorRgb.js";
import { ensureVitestCreditCardFixtures, getVitestSantanderCcMasterAccountId } from "./test/vitestDbSeed.js";

function creditCardNode() {
  const cc = getLiabilitiesNavChildren().find((n) => n.slug === "liabilities_credit_card");
  if (!cc) throw new Error("no liabilities_credit_card node");
  return cc;
}

describe("Pasivos › tarjeta de crédito", () => {
  it("lists its cards directly, in issuer order, with no issuer level", () => {
    ensureVitestCreditCardFixtures();
    const cc = creditCardNode();
    expect(cc.children.length).toBeGreaterThan(0);
    expect(cc.children.every((c) => c.account_id != null && c.children.length === 0)).toBe(true);
    const listed = cc.children.map((c) => c.account_id!);
    expect(listed).toEqual(listCreditCardMasterAccountIdsInNavOrder().filter((id) => listed.includes(id)));
    expect(cc.member_account_ids).toEqual([...listCreditCardMasterAccountIdsInNavOrder()].sort((a, b) => a - b));
  });

  it("hides a nav-retired card but keeps it a member and on the group tab", () => {
    ensureVitestCreditCardFixtures();
    const id = getVitestSantanderCcMasterAccountId()!;
    const setRetired = db.prepare(`UPDATE credit_card_account_config SET nav_retired = ? WHERE account_id = ?`);
    setRetired.run(1, id);
    try {
      const cc = creditCardNode();
      expect(cc.children.some((c) => c.account_id === id)).toBe(false);
      expect(cc.member_account_ids).toContain(id);
      expect(listLiabilitiesTabAccountRows("credit_card").some((r) => r.account_id === id)).toBe(true);
    } finally {
      setRetired.run(0, id);
    }
  });

  it("takes a colour like a portfolio group: an explicit one, else its largest member's", () => {
    ensureVitestCreditCardFixtures();
    const before = creditCardNode();
    const fallback = colorRgbOfLargestBalanceAccount(before.member_account_ids ?? []);
    expect(before.liability_group_id).toBeTypeOf("number");
    try {
      expect(updateLiabilityGroupColorRgb("liabilities_credit_card", "12,34,56")?.color_rgb).toBe("12,34,56");
      expect(creditCardNode().color_rgb).toBe("12,34,56");
      expect(updateLiabilityGroupColorRgb("liabilities_credit_card", "not a colour")).toBeNull();
    } finally {
      updateLiabilityGroupColorRgb("liabilities_credit_card", null);
    }
    expect(creditCardNode().color_rgb).toBe(fallback);
    expect(updateLiabilityGroupColorRgb("no_such_group", "1,2,3")).toBeNull();
  });
});
