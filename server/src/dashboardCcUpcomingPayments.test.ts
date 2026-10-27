import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import type { CcFacturacionRow } from "./ccBillingViews.js";
import {
  buildDashboardCcUpcomingPayments,
  ccUpcomingPaymentsFromCards,
  upcomingPaymentRows,
} from "./dashboardCcUpcomingPayments.js";

function fact(over: Partial<CcFacturacionRow> & Pick<CcFacturacionRow, "billing_month">): CcFacturacionRow {
  return {
    close_date: "",
    close_date_iso: `${over.billing_month}-24`,
    pay_by: null,
    pay_by_iso: null,
    pay_by_source: null,
    facturado_clp: null,
    facturado_usd: null,
    facturado_usd_clp: null,
    facturado_total_clp: null,
    cuota_a_pagar_clp: null,
    deuda_en_cuotas_clp: null,
    is_open_month: false,
    is_provisional_close: false,
    close_date_source: "statement",
    provisional_estimate_total_clp: null,
    usd_rate_clp: null,
    usd_rate_source: null,
    ...over,
  };
}

const TODAY = "2026-10-27";

const cardA: CcFacturacionRow[] = [
  // Open, still billing.
  fact({
    billing_month: "2026-11",
    close_date_iso: "2026-11-24",
    close_date_source: "estimated",
    pay_by_iso: "2026-12-10",
    pay_by_source: "derived",
    facturado_total_clp: 412_300,
    is_open_month: true,
  }),
  // Closed by statement, due next month.
  fact({
    billing_month: "2026-10",
    close_date_iso: "2026-10-24",
    pay_by_iso: "2026-11-09",
    pay_by_source: "statement",
    facturado_total_clp: 1_870_000.4,
  }),
  // Past its pay-by: rolled off.
  fact({
    billing_month: "2026-09",
    pay_by_iso: "2026-10-09",
    pay_by_source: "statement",
    facturado_total_clp: 900_000,
  }),
];

const cardB: CcFacturacionRow[] = [
  // Provisional close (feed), due today: still shown and due this month.
  fact({
    billing_month: "2026-10",
    close_date_iso: "2026-10-26",
    close_date_source: "feed",
    pay_by_iso: TODAY,
    pay_by_source: "derived",
    facturado_total_clp: 645_200,
    is_provisional_close: true,
  }),
  // Open with nothing billed yet: nothing to show.
  fact({
    billing_month: "2026-11",
    close_date_source: "announced",
    pay_by_iso: "2026-12-10",
    pay_by_source: "derived",
    facturado_total_clp: 0,
    is_open_month: true,
  }),
];

describe("upcoming card payments", () => {
  it("keeps the facturaciones whose pay-by is today or later, oldest first, with their evidence", () => {
    const rows = upcomingPaymentRows(cardA, TODAY);
    expect(rows.map((r) => r.billing_month)).toEqual(["2026-10", "2026-11"]);
    expect(rows[0]).toMatchObject({ close_observed: true, amount_clp: 1_870_000, pay_by_source: "statement" });
    expect(rows[1]).toMatchObject({ close_observed: false, is_open_month: true, pay_by_source: "derived" });
    const b = upcomingPaymentRows(cardB, TODAY);
    expect(b.map((r) => r.billing_month)).toEqual(["2026-10"]);
    expect(b[0].close_observed).toBe(true);
  });

  it("sums the listed rows per pay-by month and drops cards with nothing pending", () => {
    const block = ccUpcomingPaymentsFromCards(
      [
        { account_id: 1, name: "Card A", facturaciones: cardA },
        { account_id: 2, name: "Card B", facturaciones: cardB },
        { account_id: 3, name: "Card C", facturaciones: [cardA[2]] },
      ],
      TODAY,
      "/liabilities"
    );
    expect(block.cards.map((c) => c.account_id)).toEqual([1, 2]);
    // Card A's October and open November rows plus card B's October row.
    expect(block.totals_by_month).toEqual([
      // Card B's October pays today (2026-10), card A's October on 2026-11-09, its open November on 2026-12-10.
      { pay_month: "2026-10", total_clp: 645_200 },
      { pay_month: "2026-11", total_clp: 1_870_000 },
      { pay_month: "2026-12", total_clp: 412_300 },
    ]);
    expect(block.liabilities_route_path).toBe("/liabilities");
  });

  it("throws on an open facturación without a pay-by", () => {
    expect(() =>
      upcomingPaymentRows([fact({ billing_month: "2026-11", is_open_month: true, facturado_total_clp: 1 })], TODAY)
    ).toThrow(/no pay-by/);
  });

  describe("builder", () => {
    let accountId = 0;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-27T15:00:00Z"));
      const bucket = db
        .prepare(`SELECT id FROM asset_groups WHERE slug IN ('credit_card', 'credit_cards__credit_card') LIMIT 1`)
        .get() as { id: number };
      const importKey = "credit_card_master|santander|vitest-upcoming-payments-9922";
      accountId = Number(
        db
          .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · upcoming', ?, ?)`)
          .run(bucket.id, importKey, importKey).lastInsertRowid
      );
      db.prepare(
        `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4)
         VALUES (?, 21, 20, '9922')`
      ).run(accountId);
      // A statements-only card that stopped billing months ago, settled: inactive.
      db.prepare(
        `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to,
           card_last4, layout, currency, monto_facturado)
         VALUES (?, 'santander', 'vitest upcoming 2026-03.pdf', '24/03/2026', '24/02/2026', '24/03/2026', '9922', 'compact', 'clp', 150000)`
      ).run(accountId);
    });

    afterEach(() => {
      vi.useRealTimers();
      db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);
      db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(accountId);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    });

    it("leaves inactive cards out", () => {
      const block = buildDashboardCcUpcomingPayments();
      expect(block.cards.some((c) => c.account_id === accountId)).toBe(false);
      for (const card of block.cards) {
        for (const row of card.rows) expect(row.pay_by_iso >= "2026-10-27").toBe(true);
      }
    });
  });
});
