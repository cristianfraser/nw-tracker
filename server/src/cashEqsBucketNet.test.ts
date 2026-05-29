import { describe, expect, it } from "vitest";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  appendLinkedCreditCardDashboardRows,
  netLinkedCreditCardFromCashConsolidated,
  syntheticLinkedCreditCardAccountId,
} from "./cashEqsBucketNet.js";
import { creditCardLiabilityLinkRowsForCashCard } from "./liabilityTree.js";
import type { DashboardAccountStats } from "./brokerageAcciones.js";

function baseCashRow(overrides: Partial<DashboardAccountStats>): DashboardAccountStats {
  return {
    account_id: 1,
    name: "Reserva",
    group_slug: "cash_eqs",
    group_label: "Cash",
    bucket_slug: "cash_eqs",
    bucket_label: "Cash",
    dashboard_bucket_slug: "cash_eqs",
    category_slug: "fondo_reserva",
    category_label: "Reserva",
    deposits_clp: 0,
    current_value_clp: 1_000_000,
    valuation_as_of: "2026-01-01",
    current_value_usd: null,
    fx_clp_per_usd: null,
    fx_date_used: null,
    notes: null,
    chart_inactive: false,
    ...overrides,
  };
}

describe("cash_eqs bucket net (linked tarjeta de crédito)", () => {
  it("synthetic dashboard rows negate linked CC balances", () => {
    const asOf = chileCalendarTodayYmd();
    const links = creditCardLiabilityLinkRowsForCashCard(asOf);
    if (!links.length) return;

    const rows = appendLinkedCreditCardDashboardRows([baseCashRow({})], asOf, false);
    const cashTotal = rows
      .filter((r) => r.dashboard_bucket_slug === "cash_eqs")
      .reduce((s, r) => s + (r.current_value_clp ?? 0), 0);
    const linkedSum = links.reduce((s, l) => s + l.clp, 0);
    expect(cashTotal).toBeCloseTo(1_000_000 - linkedSum, 0);
    expect(rows.some((r) => r.account_id === syntheticLinkedCreditCardAccountId(links[0]!.liability_account_id))).toBe(
      true
    );
  });

  it("netLinkedCreditCardFromCashConsolidated subtracts CC from closing and prior", () => {
    const asOf = chileCalendarTodayYmd();
    const links = creditCardLiabilityLinkRowsForCashCard(asOf);
    if (!links.length) return;

    const linked = links.reduce((s, l) => s + l.clp, 0);
    const consolidated = netLinkedCreditCardFromCashConsolidated(
      [
        {
          as_of_date: asOf,
          closing_value: 1_000_000 + linked,
          prior_closing: 900_000 + linked,
          net_capital_flow: 0,
          stock_units_inflow: 0,
          nominal_pl: 100_000,
          pct_month: null,
          ytd_nominal_pl: null,
          cumulative_nominal_pl: null,
        },
      ],
      "clp"
    );
    expect(consolidated[0]!.closing_value).toBeCloseTo(1_000_000, 0);
    expect(consolidated[0]!.prior_closing).not.toBeCloseTo(900_000 + linked, 0);
  });
});
