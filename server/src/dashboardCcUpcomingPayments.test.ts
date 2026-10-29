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

const TODAY = "2026-10-29";
const RATE = 1000;
const live = () => RATE;
const none = { clp: [], usd: [], open_credits: { clp: 0, usd: 0 } };

// A card that closed October on the 26th (pesos and dollars) and keeps billing November.
const october = fact({
  billing_month: "2026-10",
  close_date_iso: "2026-10-26",
  pay_by_iso: "2026-11-10",
  pay_by_source: "statement",
  facturado_clp: 2_000_000,
  facturado_usd: 300,
  facturado_usd_clp: 300_000,
  facturado_total_clp: 2_300_000,
});
const november = fact({
  billing_month: "2026-11",
  close_date_iso: "2026-11-24",
  close_date_source: "announced",
  pay_by_iso: "2026-12-10",
  pay_by_source: "derived",
  facturado_clp: 400_000,
  facturado_usd: 50,
  facturado_usd_clp: 50_000,
  facturado_total_clp: 450_000,
  is_open_month: true,
});
const september = fact({
  billing_month: "2026-09",
  close_date_iso: "2026-09-24",
  pay_by_iso: "2026-10-09",
  pay_by_source: "statement",
  facturado_clp: 900_000,
  facturado_total_clp: 900_000,
});
const card = [september, october, november];

describe("upcoming card payments", () => {
  it("lists the latest closed facturación and the open one, oldest first", () => {
    const rows = upcomingPaymentRows(card, none, TODAY, live);
    expect(rows.map((r) => r.billing_month)).toEqual(["2026-10", "2026-11"]);
    expect(rows[0]).toMatchObject({
      close_observed: true,
      amount_clp: 2_300_000,
      billed_clp: 2_300_000,
      overdue: false,
      pay_by_source: "statement",
    });
    expect(rows[1]).toMatchObject({ close_observed: false, is_open_month: true, amount_clp: 450_000 });
  });

  it("takes the payments made since the close off, per currency, and drops a row once paid", () => {
    // The peso side paid in full; the 2026-10-09 dollar payment paid September, not October.
    const pesosPaid = {
      ...none,
      clp: [{ date_iso: "2026-10-29", amount: 2_000_000 }],
      usd: [{ date_iso: "2026-10-09", amount: 300 }],
    };
    const rows = upcomingPaymentRows(card, pesosPaid, TODAY, live);
    expect(rows[0]).toMatchObject({ billing_month: "2026-10", amount_clp: 300_000, billed_clp: 2_300_000 });
    const allPaid = { ...pesosPaid, usd: [{ date_iso: "2026-10-30", amount: 300 }] };
    expect(upcomingPaymentRows(card, allPaid, TODAY, live).map((r) => r.billing_month)).toEqual(["2026-11"]);
  });

  it("applies the open cycle's credits to the closed facturación first", () => {
    // A nota de crédito of US$7,50 after the close: paying US$292,50 settles October, and November
    // (whose facturado nets the nota) gets it back.
    const rows = upcomingPaymentRows(
      card,
      {
        clp: [{ date_iso: "2026-10-28", amount: 2_000_000 }],
        usd: [{ date_iso: "2026-10-28", amount: 292.5 }],
        open_credits: { clp: 0, usd: 7.5 },
      },
      TODAY,
      live
    );
    expect(rows.map((r) => r.billing_month)).toEqual(["2026-11"]);
    expect(rows[0].amount_clp).toBe(400_000 + 57_500);
  });

  it("carries an overpayment into the open facturación, same currency", () => {
    const rows = upcomingPaymentRows(
      card,
      { ...none, clp: [{ date_iso: "2026-10-28", amount: 2_100_000 }], usd: [{ date_iso: "2026-10-28", amount: 300 }] },
      TODAY,
      live
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ billing_month: "2026-11", amount_clp: 300_000 + 50_000, billed_clp: 450_000 });
  });

  it("keeps a closed facturación past its pay-by while it still owes, marked overdue", () => {
    const rows = upcomingPaymentRows(card, none, "2026-11-12", live);
    expect(rows[0]).toMatchObject({ billing_month: "2026-10", overdue: true, amount_clp: 2_300_000 });
    const block = ccUpcomingPaymentsFromCards(
      [{ account_id: 1, name: "Card", facturaciones: card, payments: none }],
      "2026-11-12",
      live,
      null
    );
    // The overdue October is due now (November), beside the open November's December pay-by.
    expect(block.totals_by_month).toEqual([
      { pay_month: "2026-11", total_clp: 2_300_000 },
      { pay_month: "2026-12", total_clp: 450_000 },
    ]);
  });

  it("does not read today's rate when no dollars are owed", () => {
    const rows = upcomingPaymentRows([september], none, TODAY, () => {
      throw new Error("no rate");
    });
    expect(rows.map((r) => r.billing_month)).toEqual(["2026-09"]);
  });

  it("sums the listed rows per pay-by month and drops cards with nothing pending", () => {
    const paid = { ...none, clp: [{ date_iso: "2026-10-01", amount: 900_000 }] };
    const block = ccUpcomingPaymentsFromCards(
      [
        { account_id: 1, name: "Card A", facturaciones: card, payments: none },
        { account_id: 2, name: "Card B", facturaciones: [september], payments: paid },
      ],
      TODAY,
      live,
      "/liabilities"
    );
    expect(block.cards.map((c) => c.account_id)).toEqual([1]);
    expect(block.totals_by_month).toEqual([
      { pay_month: "2026-11", total_clp: 2_300_000 },
      { pay_month: "2026-12", total_clp: 450_000 },
    ]);
    expect(block.liabilities_route_path).toBe("/liabilities");
  });

  it("throws on an open facturación without a pay-by", () => {
    expect(() =>
      upcomingPaymentRows(
        [fact({ billing_month: "2026-11", is_open_month: true, facturado_clp: 1, facturado_total_clp: 1 })],
        none,
        TODAY,
        live
      )
    ).toThrow(/no pay-by/);
  });

  describe("builder", () => {
    let accountId = 0;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-29T15:00:00Z"));
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
      for (const c of block.cards) expect(c.rows.length).toBeLessThanOrEqual(2);
    });
  });
});
