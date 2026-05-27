import { describe, expect, it } from "vitest";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  creditCardLiabilityLinkRowsForCashCard,
  linkedCreditCardClpForCashCardAsOf,
} from "./liabilityTree.js";
import { liabilitiesBreakdownClpAsOf } from "./liabilitiesValuation.js";

describe("linked credit card for Efectivo net", () => {
  it("linked total equals sum of per-card link rows at today", () => {
    const asOf = chileCalendarTodayYmd();
    const links = creditCardLiabilityLinkRowsForCashCard(asOf);
    if (links.length === 0) return;

    const fromLinks = links.reduce((s, r) => s + r.clp, 0);
    expect(linkedCreditCardClpForCashCardAsOf(asOf)).toBeCloseTo(fromLinks, 0);
  });

  it("linked credit card total is at most full Pasivos CC breakdown", () => {
    const asOf = chileCalendarTodayYmd();
    const linked = linkedCreditCardClpForCashCardAsOf(asOf);
    if (linked <= 0) return;

    const full = liabilitiesBreakdownClpAsOf(asOf, { mortgageFromDeptoSheet: true });
    expect(linked).toBeLessThanOrEqual(full.credit_card_clp + 1);
  });
});
