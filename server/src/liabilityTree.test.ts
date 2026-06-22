import { afterEach, describe, expect, it } from "vitest";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import {
  creditCardLiabilityLinkRowsForCashCard,
  linkedCreditCardClpForCashCardAsOf,
} from "./liabilityTree.js";
import { liabilitiesBreakdownClpAsOf, clearAccountCategoryMetaCache } from "./liabilitiesValuation.js";

const restoredExcludeFlags = new Map<number, number>();

afterEach(() => {
  for (const [id, prev] of restoredExcludeFlags) {
    db.prepare(`UPDATE accounts SET exclude_from_group_totals = ? WHERE id = ?`).run(prev, id);
  }
  restoredExcludeFlags.clear();
  clearAccountCategoryMetaCache();
});

function setExcludeFromGroupTotals(accountId: number, value: 0 | 1): void {
  const prev = db
    .prepare(`SELECT exclude_from_group_totals FROM accounts WHERE id = ?`)
    .get(accountId) as { exclude_from_group_totals: number } | undefined;
  if (!prev) return;
  if (!restoredExcludeFlags.has(accountId)) {
    restoredExcludeFlags.set(accountId, prev.exclude_from_group_totals);
  }
  db.prepare(`UPDATE accounts SET exclude_from_group_totals = ? WHERE id = ?`).run(value, accountId);
}

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

  it("omits liability_view rows with exclude_from_group_totals from linked CC total", () => {
    const asOf = chileCalendarTodayYmd();
    const linksBefore = creditCardLiabilityLinkRowsForCashCard(asOf);
    if (linksBefore.length === 0) return;

    const target = linksBefore[0]!;
    const totalBefore = linkedCreditCardClpForCashCardAsOf(asOf);
    expect(totalBefore).toBeGreaterThan(0);

    setExcludeFromGroupTotals(target.liability_account_id, 1);

    const linksAfter = creditCardLiabilityLinkRowsForCashCard(asOf);
    expect(linksAfter.some((r) => r.liability_account_id === target.liability_account_id)).toBe(
      false
    );
    expect(linkedCreditCardClpForCashCardAsOf(asOf)).toBeCloseTo(totalBefore - target.clp, 0);
  });
});
