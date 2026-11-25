import { describe, expect, it } from "vitest";
import { addCalendarMonths } from "nw-tracker-contracts";
import { billingCurrencyConverter } from "./ccGlance.js";
import { ccGroupLanesResponse } from "./ccGroupLanes.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { buildDashboardAccountRow } from "./dashboardAccounts.js";
import { roundToCurrency } from "./displayUnits.js";
import { buildLiabilitiesGlance, CREDIT_CARD_GROUP_SLUG, LIABILITIES_ROOT_SLUG } from "./liabilitiesGlance.js";
import { listLiabilitiesTabAccountRows } from "./liabilityTabAccounts.js";
import { UPCOMING_PAYMENTS_HORIZON_MONTHS } from "./upcomingPayments.js";

/**
 * The Vitest person's Pasivos (two cards with cuotas, a rented flat): the page's figures are the
 * credit-card group page's, in the unit asked for.
 */
describe("liabilities glance", () => {
  it("answers only for the Pasivos root", async () => {
    expect(await buildLiabilitiesGlance(CREDIT_CARD_GROUP_SLUG, "clp")).toBeNull();
  });

  it("totals the card group's lanes, its upcoming payments and the cards' financing cost", async () => {
    const today = chileCalendarTodayYmd();
    const lanes = ccGroupLanesResponse(CREDIT_CARD_GROUP_SLUG);
    expect(lanes.cards.length).toBeGreaterThan(0);
    for (const unit of ["clp", "usd"] as const) {
      const g = (await buildLiabilitiesGlance(LIABILITIES_ROOT_SLUG, unit))!;
      const toUnit = billingCurrencyConverter(today, unit);
      const owed = roundToCurrency(lanes.total.owed.reduce((a, o) => a + toUnit(o.amount, o.currency), 0), unit);
      // The cards are everything owed: their share is whole (none when they owe nothing).
      expect(g.cards).toEqual({ slug: CREDIT_CARD_GROUP_SLUG, owed, share: owed > 0 ? 1 : 0, count: lanes.cards.length });
      expect(g.mortgage).toBeNull();
      expect(g.total).toBe(owed);

      // Every month inside the «Próximos pagos» horizon, an earlier one folded into this month.
      const first = today.slice(0, 7);
      const last = addCalendarMonths(first, UPCOMING_PAYMENTS_HORIZON_MONTHS - 1);
      const lanesInHorizon = lanes.upcoming_months.filter((m) => m.month <= last);
      expect(g.upcoming_months.map((m) => m.month)).toEqual(
        [...new Set(lanesInHorizon.map((m) => (m.month < first ? first : m.month)))].sort()
      );
      for (const m of g.upcoming_months) {
        expect(m.total_max).toBeNull();
        expect(m.parts.every((p) => p.kind === "card" && p.amount_max == null)).toBe(true);
        // One part per card and month: its bill and its cuotas together.
        expect(new Set(m.parts.map((p) => p.account_id)).size).toBe(m.parts.length);
        expect(m.total).toBeCloseTo(m.parts.reduce((a, p) => a + p.amount, 0), 2);
      }
      if (unit === "clp") {
        const lanesTotal = lanesInHorizon.reduce((a, m) => a + m.total, 0);
        expect(g.upcoming_months.reduce((a, m) => a + m.total, 0)).toBe(lanesTotal);
      }

      const rows = listLiabilitiesTabAccountRows("credit_card").map((r) => buildDashboardAccountRow(r.account_id, unit)!);
      // The strip: each card's own dashboard row, summed over the cards that have the period.
      const sum = (pick: (r: (typeof rows)[number]) => number | null | undefined) => {
        const have = rows.map(pick).filter((v): v is number => v != null);
        return have.length === 0 ? null : roundToCurrency(have.reduce((a, v) => a + v, 0), unit);
      };
      expect(g.strip.month).toBe(sum((r) => r.delta_month));
      expect(g.strip.total).toBe(sum((r) => r.delta_total));
    }
  });
});
