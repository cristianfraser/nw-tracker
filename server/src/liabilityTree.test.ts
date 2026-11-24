import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { creditCardLiabilityLinkRowsForCashCard, linkedCreditCardClpForCashCardAsOf } from "./liabilityTree.js";
import { liabilitiesBreakdownClpAsOf } from "./liabilitiesValuation.js";
import { createTempCardMaster, deleteTempCardMaster } from "./test/tempCardMaster.js";

/** A past month-end (never today: the historical branch reads the stored anchor as is). */
const AS_OF = "2024-03-31";
const OWED_CLP = 100_000;

let cardId = 0;

beforeAll(() => {
  cardId = createTempCardMaster({ issuer: "santander", last4: "0941", key: "vitest-liability-tree" });
  const group = db
    .prepare(`SELECT id FROM liability_groups WHERE slug = 'liabilities_credit_card'`)
    .get() as { id: number };
  db.prepare(
    `INSERT INTO liability_group_items (group_id, item_kind, account_id, sort_order) VALUES (?, 'account', ?, 99)`
  ).run(group.id, cardId);
  db.prepare(`INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')`).run(
    cardId,
    AS_OF,
    OWED_CLP
  );
});

afterAll(() => {
  if (cardId) deleteTempCardMaster(cardId);
});

afterEach(() => {
  db.prepare(`UPDATE accounts SET exclude_from_group_totals = 0 WHERE id = ?`).run(cardId);
});

function setExcludeFromGroupTotals(value: 0 | 1): void {
  db.prepare(`UPDATE accounts SET exclude_from_group_totals = ? WHERE id = ?`).run(value, cardId);
}

describe("linked credit card for Efectivo net", () => {
  it("linked total equals sum of per-card link rows", () => {
    const links = creditCardLiabilityLinkRowsForCashCard(AS_OF);
    const own = links.find((r) => r.liability_account_id === cardId);
    expect(own).toEqual({
      liability_account_id: cardId,
      operational_account_id: cardId,
      name: "Vitest · vitest-liability-tree",
      clp: OWED_CLP,
    });

    const fromLinks = links.reduce((s, r) => s + r.clp, 0);
    expect(linkedCreditCardClpForCashCardAsOf(AS_OF)).toBeCloseTo(fromLinks, 0);
  });

  it("a linked card counts in the Pasivos CC breakdown too, and the linked total stays within it", () => {
    const linkedWith = linkedCreditCardClpForCashCardAsOf(AS_OF);
    const fullWith = liabilitiesBreakdownClpAsOf(AS_OF).credit_card_clp;
    expect(linkedWith).toBeLessThanOrEqual(fullWith + 1);

    setExcludeFromGroupTotals(1);
    expect(linkedWith - linkedCreditCardClpForCashCardAsOf(AS_OF)).toBeCloseTo(OWED_CLP, 0);
    expect(fullWith - liabilitiesBreakdownClpAsOf(AS_OF).credit_card_clp).toBeCloseTo(OWED_CLP, 0);
  });

  it("omits liability_view rows with exclude_from_group_totals from linked CC total", () => {
    const totalBefore = linkedCreditCardClpForCashCardAsOf(AS_OF);

    setExcludeFromGroupTotals(1);

    const linksAfter = creditCardLiabilityLinkRowsForCashCard(AS_OF);
    expect(linksAfter.some((r) => r.liability_account_id === cardId)).toBe(false);
    expect(linkedCreditCardClpForCashCardAsOf(AS_OF)).toBeCloseTo(totalBefore - OWED_CLP, 0);
  });
});
