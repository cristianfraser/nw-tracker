import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./cacheRegistry.js";
import { listCcBillingMonthBalances, normalizedPostCloseLines } from "./ccBillingBalances.js";
import { feedCloseStatementMismatches, recordFeedBillingClose } from "./ccBillingCloses.js";
import { recomputeCcBillingMonthBalances } from "./ccBillingMonthBalancesRecompute.js";
import { buildBillingDetailByMonth, buildFacturaciones, ccStatementOwedByCurrencyByMonth, facturadoForeignIn } from "./ccBillingViews.js";
import { recordManualCardPayment } from "./ccManualPayments.js";
import { listPlantedPaymentLines } from "./ccPlantedPayments.js";
import { createPanelAccount } from "./createPanelAccount.js";
import { db } from "./db.js";
import { deleteTempCardMaster } from "./test/tempCardMaster.js";
import { cardPaymentMoney, loadCardPaymentTransfers } from "./latestCardPayments.js";

/**
 * Wave 9 `ut-card-currency`: a card that bills in euros only (issuer `euronova`) and a card whose
 * primary statement is in dollars (issuer `lonestar`) go through the same card paths, none of
 * which names a currency: the statement debt frame, what a statement and a slot billed, the stored
 * billing snapshot, the post-close evidence (lines, a payment of the previous facturación, a
 * header payment leg, a financing charge read from its stored kind), a feed-observed close and its
 * cross-check, and a payment entered by hand with its planted line.
 */
type Fixture = {
  label: string;
  issuer: string;
  cardGroup: string;
  currency: string;
  /** Pesos per unit on the debt-frame day of the first facturación and of the second. */
  rateA: number;
  rateB: number;
  rateTable: "eur_daily" | "fx_daily";
  rateColumn: "clp_per_eur" | "clp_per_usd";
  year: number;
};

const FIXTURES: Fixture[] = [
  { label: "a euro card", issuer: "euronova", cardGroup: "EURONOVA", currency: "eur", rateA: 1010, rateB: 1040, rateTable: "eur_daily", rateColumn: "clp_per_eur", year: 2037 },
  { label: "a dollar-primary card", issuer: "lonestar", cardGroup: "A", currency: "usd", rateA: 910, rateB: 940, rateTable: "fx_daily", rateColumn: "clp_per_usd", year: 2038 },
];

const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

for (const fx of FIXTURES) {
  describe(`${fx.label} through the card paths`, () => {
    const NOTE = `vitest-any-currency-card-${fx.currency}`;
    const y = fx.year;
    const days = {
      closeA: `${y}-03-05`,
      payByA: `${y}-03-30`,
      closeB: `${y}-04-05`,
      payByB: `${y}-04-30`,
      purchaseA: `${y}-02-20`,
      interestA: `${y}-03-04`,
      purchaseB: `${y}-03-10`,
      payment: `${y}-03-20`,
      leg: `${y}-03-25`,
      manual: `${y}-04-12`,
      feedClose: `${y}-05-05`,
    };
    // Debt-frame days (pay-by − 1) of the two facturaciones.
    const rateDays: [string, number][] = [
      [`${y}-01-01`, fx.rateA - 20],
      [`${y}-03-29`, fx.rateA],
      [`${y}-04-29`, fx.rateB],
    ];
    const CARD_KEY = `credit_card_master|${fx.issuer}|${NOTE}`;
    const CASH_SLUG = `vitest_any_currency_card_cash_${fx.currency}`;
    let batchFloor = 0;
    let cardId = 0;
    let cashId = 0;
    let monthA = "";
    let monthB = "";

    /** Everything this fixture files, found by its own keys (also what a failed earlier run left). */
    function removeFixture(): void {
      const card = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(CARD_KEY) as { id: number } | undefined;
      db.prepare(`DELETE FROM movements WHERE note = ?`).run(NOTE);
      if (card) {
        db.prepare(`DELETE FROM movements WHERE to_account_id = ? OR from_account_id = ?`).run(card.id, card.id);
        deleteTempCardMaster(card.id);
      }
      const groups = db.prepare(`SELECT id FROM asset_groups WHERE slug LIKE ?`).all(`%${CASH_SLUG}%`) as { id: number }[];
      for (const g of groups) {
        db.prepare(`DELETE FROM accounts WHERE asset_group_id = ?`).run(g.id);
        db.prepare(`DELETE FROM asset_groups WHERE id = ?`).run(g.id);
      }
      for (const [date] of rateDays) db.prepare(`DELETE FROM ${fx.rateTable} WHERE date = ?`).run(date);
      clearAggregationCache();
    }

    beforeAll(() => {
      removeFixture();
      batchFloor = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM import_batches`).get() as { id: number }).id;
      const leaf = db
        .prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%__credit_card' OR slug LIKE 'credit_cards__%' LIMIT 1`)
        .get() as { id: number };
      cardId = Number(
        db
          .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, ?, ?)`)
          .run(leaf.id, `Vitest · any-currency card ${fx.currency}`, NOTE, CARD_KEY).lastInsertRowid
      );
      db.prepare(
        `INSERT INTO credit_card_account_config (account_id, card_last4, billing_cycle_start_day, billing_cycle_end_day, issuer)
         VALUES (?, '4471', 6, 5, ?)`
      ).run(cardId, fx.issuer);
      const cash = createPanelAccount({
        account: {
          account_type: "foreign_cash",
          currency: fx.currency,
          name: `Vitest any-currency card cash ${fx.currency}`,
          bucket_slug: "cash_savings",
          category_slug: CASH_SLUG,
          exclude_from_group_totals: true,
        },
      });
      cashId = cash.account_id;
      // The cash a hand payment will leave from, priced by the cost tracer at the day's stored rate.
      db.prepare(
        `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, 500, ?, ?, ?, 'deposit')`
      ).run(cashId, fx.currency, `${y}-01-05`, NOTE);
      for (const [date, rate] of rateDays) {
        db.prepare(`INSERT OR REPLACE INTO ${fx.rateTable} (date, ${fx.rateColumn}) VALUES (?, ?)`).run(date, rate);
      }
      const statement = (close: string, payBy: string, facturado: number): number =>
        Number(
          db
            .prepare(
              `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_to, currency, layout, monto_facturado, pay_by)
               VALUES (?, ?, ?, ?, ?, ?, 'compact', ?, ?)`
            )
            .run(cardId, fx.cardGroup, `${NOTE}-${close}.pdf`, ddmm(close), ddmm(close), fx.currency, facturado, ddmm(payBy)).lastInsertRowid
        );
      const line = db.prepare(
        `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, currency, installment_flag, kind, dedupe_key)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
      );
      const a = statement(days.closeA, days.payByA, 200);
      line.run(a, ddmm(days.purchaseA), "LIBRERIA VITEST", 190, fx.currency, "card_purchase", `${NOTE}-a-purchase`);
      line.run(a, ddmm(days.interestA), "INTERESES", 10, fx.currency, "financing_charge", `${NOTE}-a-interest`);
      const b = statement(days.closeB, days.payByB, 80);
      line.run(b, ddmm(days.purchaseB), "CAFE VITEST", 80, fx.currency, "card_purchase", `${NOTE}-b-purchase`);
      line.run(b, ddmm(days.payment), "PAGO", -150, fx.currency, "card_payment", `${NOTE}-b-payment`);
      db.prepare(
        `INSERT INTO cc_header_payment_legs (account_id, statement_close_iso, currency, paid_on, amount, source)
         VALUES (?, ?, ?, ?, 30, 'pay_by')`
      ).run(cardId, days.closeB, fx.currency, days.leg);
      clearAggregationCache();
      const rows = buildFacturaciones(cardId, []);
      monthA = rows.find((r) => r.close_date_iso === days.closeA)!.billing_month;
      monthB = rows.find((r) => r.close_date_iso === days.closeB)!.billing_month;
    });

    afterAll(() => {
      removeFixture();
      db.prepare(`DELETE FROM import_batches WHERE id > ? AND kind = 'cc_manual_payment'`).run(batchFloor);
    });

    it("bills each facturación in its currency, with no peso side", () => {
      const rows = buildFacturaciones(cardId, []);
      const a = rows.find((r) => r.billing_month === monthA)!;
      const b = rows.find((r) => r.billing_month === monthB)!;
      expect(a.facturado).toBeNull();
      expect(facturadoForeignIn(a, fx.currency)!.amount).toBe(200);
      expect(facturadoForeignIn(b, fx.currency)!.amount).toBe(80);
      // Every foreign entry is the card's own currency: no dollar twin on a euro card.
      expect(a.facturado_foreign.map((f) => f.currency)).toEqual([fx.currency]);
    });

    it("values a facturación's statement frame at the stored close of its pay-by − 1", () => {
      const detail = buildBillingDetailByMonth(cardId, []);
      expect(detail.find((r) => r.billing_month === monthA)!.total_facturado).toBe(200 * fx.rateA);
      expect(detail.find((r) => r.billing_month === monthB)!.total_facturado).toBe(80 * fx.rateB);
    });

    it("splits the statement frame into the currency it is owed in", () => {
      const owed = ccStatementOwedByCurrencyByMonth(cardId, []);
      // March's month-end: the 200 billed, the purchase of the next cycle, less the payment and the header leg.
      expect(owed.get(monthA)![fx.currency]).toBeCloseTo(200 + 80 - 150 - 30, 2);
      expect(owed.get(monthA)!.clp).toBe(0);
    });

    it("reads the post-close evidence in its own currency: the financing kind, the paid facturación's rate, the header leg", () => {
      const lines = normalizedPostCloseLines(cardId);
      const interest = lines.find((l) => l.key === `${NOTE}-a-interest`)!;
      expect(interest).toMatchObject({ currency: fx.currency, amount: 10, clp: 10 * fx.rateA, financing: true });
      expect(lines.find((l) => l.key === `${NOTE}-a-purchase`)!.financing).toBeUndefined();
      // The payment sits on the second statement and paid the first: valued at the first's debt frame.
      const payment = lines.find((l) => l.key === `${NOTE}-b-payment`)!;
      expect(payment).toMatchObject({ currency: fx.currency, amount: -150, clp: -150 * fx.rateA });
      const leg = lines.find((l) => l.key.startsWith("hdr-leg|"))!;
      expect(leg).toMatchObject({ iso: days.leg, currency: fx.currency, amount: -30, clp: -30 * fx.rateA });
    });

    it("stores the billing snapshot per currency", () => {
      recomputeCcBillingMonthBalances(cardId);
      const rows = listCcBillingMonthBalances(cardId);
      expect(rows.find((r) => r.billing_month === monthA)!.facturado_by_currency[fx.currency]).toBe(200);
      expect(rows.find((r) => r.billing_month === monthB)!.facturado_by_currency[fx.currency]).toBe(80);
    });

    it("cross-checks a feed-observed close against the statement in the statement's currency", () => {
      recordFeedBillingClose(cardId, { close_iso: days.closeB, saldo_inicial: { [fx.currency]: 80 }, source_file: null });
      expect(feedCloseStatementMismatches(cardId)).toEqual([]);
      expect(() =>
        recordFeedBillingClose(cardId, { close_iso: days.closeB, saldo_inicial: { [fx.currency]: 81 }, source_file: null })
      ).toThrow(new RegExp(`${fx.currency.toUpperCase()} 80 → 81`));
      db.prepare(`DELETE FROM cc_feed_billing_closes WHERE account_id = ?`).run(cardId);
    });

    it("closes a month provisionally on the feed's figure in that currency", () => {
      recordFeedBillingClose(cardId, { close_iso: days.feedClose, saldo_inicial: { [fx.currency]: 55 }, source_file: null });
      clearAggregationCache();
      const row = buildFacturaciones(cardId, []).find((r) => r.close_date_iso === days.feedClose)!;
      expect(row.is_provisional_close).toBe(true);
      expect(facturadoForeignIn(row, fx.currency)!.amount).toBe(55);
      expect(row.facturado).toBe(0);
      db.prepare(`DELETE FROM cc_feed_billing_closes WHERE account_id = ?`).run(cardId);
      clearAggregationCache();
    });

    it("records a payment entered by hand in the card's currency and plants its line", () => {
      const result = recordManualCardPayment({
        from_account_id: cashId,
        card_account_id: cardId,
        amount: 12.349,
        currency: fx.currency,
        paid_on: days.manual,
      });
      expect(result.status).toBe("recorded");
      expect(result.card_line).toBe("planted");
      const planted = listPlantedPaymentLines(cardId).find((p) => p.line_id === result.planted_line_id)!;
      expect(planted).toMatchObject({ currency: fx.currency, amount: 12.35, paid_on: days.manual });
      const stored = db
        .prepare(`SELECT merchant, amount, currency, kind FROM cc_statement_lines WHERE id = ?`)
        .get(result.planted_line_id) as { merchant: string; amount: number; currency: string; kind: string };
      // The card's main statement is in this currency, so its payment is a «PAGO».
      expect(stored).toEqual({ merchant: "PAGO", amount: -12.35, currency: fx.currency, kind: "card_payment" });
      const transfer = loadCardPaymentTransfers().find((t) => t.movement_id === result.transfer_movement_id)!;
      const money = cardPaymentMoney(transfer);
      expect(money.amount).toEqual({ value: 12.35, currency: fx.currency });
      expect(money.values[fx.currency]).toEqual({ value: 12.35, rate_source: "native" });
      // A second call for the same payment changes nothing.
      expect(
        recordManualCardPayment({ from_account_id: cashId, card_account_id: cardId, amount: 12.35, currency: fx.currency, paid_on: days.manual }).status
      ).toBe("already_recorded");
    });

    it("refuses a hand payment in a currency the issuer does not bill in, or from an account in another currency", () => {
      expect(() =>
        recordManualCardPayment({ from_account_id: cashId, card_account_id: cardId, amount: 5, currency: "uf", paid_on: days.manual })
      ).toThrow();
      // Pesos from a foreign cash account: the source does not hold them.
      expect(() =>
        recordManualCardPayment({ from_account_id: cashId, card_account_id: cardId, amount: 5000, currency: "clp", paid_on: days.manual })
      ).toThrow(/does not hold CLP/);
    });
  });
}
