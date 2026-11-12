import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./cacheRegistry.js";
import { buildFacturaciones, ccStatementOwedByCurrencyByMonth, facturadoForeignIn } from "./ccBillingViews.js";
import { cardForeignCurrencies, foreignDebtPaymentsForAccount } from "./ccFacturacionForeignRate.js";
import { ccPaymentEvidenceKey, listCcPaymentEvidenceRows } from "./ccPaymentMirrorEvidence.js";
import { createPanelAccount } from "./createPanelAccount.js";
import { db } from "./db.js";
import { buildCcExpenseLines } from "./flowsExpenses.js";
import { linePesos, lineAmount, withLineMoney } from "./lineMoney.js";

/**
 * A card that bills in euros, read back (docs/any-currency-plan.md C3): its facturación row bills
 * euros with the pesos they were actually paid at (a payment from a euro cash account, priced by the
 * cost tracer), its expense line is a euro line at that rate, its ABONO DE DIVISAS is payment
 * evidence keyed in euros, and the statement frame splits into a euro part.
 */
const NOTE = "vitest-euro-card-facturacion";
const days = { buy: "2036-02-25", purchase: "2036-02-20", close: "2036-03-05", pay: "2036-03-09", payBy: "2036-03-30" };
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const created: { account_id: number; asset_group_id: number; created_leaf_bucket: boolean }[] = [];
let cardId = 0;
let statementId = 0;
let abonoLineId = 0;

beforeAll(() => {
  const leaf = db
    .prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%__credit_card' OR slug LIKE 'credit_cards__%' LIMIT 1`)
    .get() as { id: number };
  cardId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key)
         VALUES (?, 'Vitest · euro card facturación', ?, 'credit_card_master|euronova|vitest-euro-facturacion')`
      )
      .run(leaf.id, NOTE).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO credit_card_account_config (account_id, card_last4, billing_cycle_start_day, billing_cycle_end_day, issuer)
     VALUES (?, '4402', 6, 5, 'euronova')`
  ).run(cardId);
  const eur = createPanelAccount({
    account: { account_type: "foreign_cash", currency: "eur", name: "Vitest euro card cash", bucket_slug: "cash_savings", category_slug: "vitest_euro_card_cash", exclude_from_group_totals: true },
  });
  const clp = createPanelAccount({
    account: { account_type: "clp_cash", name: "Vitest euro card pesos", bucket_slug: "cash_savings", category_slug: "vitest_euro_card_pesos", exclude_from_group_totals: true },
  });
  created.push(eur, clp);
  for (const [date, rate] of [["2036-02-01", 1000], [days.close, 1010], [days.pay, 1030]] as const) {
    db.prepare(`INSERT OR REPLACE INTO eur_daily (date, clp_per_eur) VALUES (?, ?)`).run(date, rate);
  }
  const mv = db.prepare(
    `INSERT INTO movements (from_account_id, to_account_id, amount, currency, counter_amount, counter_currency, occurred_on, note, flow_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // 500 euros for 510.000 pesos; 200 of them pay the card's March facturación.
  mv.run(clp.account_id, eur.account_id, 510_000, "clp", 500, "eur", days.buy, NOTE, "fx_exchange");
  mv.run(eur.account_id, cardId, 200, "eur", null, null, days.pay, NOTE, "pago_tarjeta");
  statementId = Number(
    db
      .prepare(
        `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, currency, layout, monto_facturado, pay_by)
         VALUES (?, 'EURONOVA', 'vitest-euro-facturacion.pdf', ?, 'eur', 'compact', 200, ?)`
      )
      .run(cardId, ddmm(days.close), ddmm(days.payBy)).lastInsertRowid
  );
  const line = db.prepare(
    `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, currency, installment_flag, dedupe_key)
     VALUES (?, ?, ?, ?, 'eur', 0, ?)`
  );
  line.run(statementId, ddmm(days.purchase), "LIBRAIRIE VITEST", 200, "vitest-euro-fact-line");
  abonoLineId = Number(line.run(statementId, ddmm("2036-03-07"), "ABONO DE DIVISAS", -50, "vitest-euro-fact-abono").lastInsertRowid);
  clearAggregationCache();
});

afterAll(() => {
  db.prepare(`DELETE FROM movements WHERE note = ?`).run(NOTE);
  db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(cardId);
  db.prepare(`DELETE FROM cc_owed_anchors WHERE account_id = ?`).run(cardId);
  db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(cardId);
  db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(cardId);
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(cardId);
  for (const c of created) {
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(c.account_id);
    if (c.created_leaf_bucket) db.prepare(`DELETE FROM asset_groups WHERE id = ?`).run(c.asset_group_id);
  }
  for (const d of ["2036-02-01", days.close, days.pay]) db.prepare(`DELETE FROM eur_daily WHERE date = ?`).run(d);
  clearAggregationCache();
});

describe("a euro card's facturaciones", () => {
  it("bills in euros, the one foreign currency it bills in", () => {
    expect(cardForeignCurrencies(cardId)).toEqual(["eur"]);
  });

  it("prices a euro payment from a euro cash account at the pesos those euros cost", () => {
    expect(foreignDebtPaymentsForAccount(cardId, "eur")).toEqual([{ date_iso: days.pay, clp: 204_000, amount: 200 }]);
  });

  it("shows the facturación's euros at the rate they were paid", () => {
    const row = buildFacturaciones(cardId, []).find((f) => f.close_date_iso === days.close)!;
    expect(row.facturado_clp).toBeNull();
    expect(facturadoForeignIn(row, "eur")).toEqual({ currency: "eur", amount: 200, clp: 204_000, rate_clp: 1020, rate_source: "paid" });
    expect(facturadoForeignIn(row, "usd")).toBeNull();
    expect(row.facturado_total_clp).toBe(204_000);
  });

  it("splits the statement frame into its euros", () => {
    const owed = ccStatementOwedByCurrencyByMonth(cardId, []);
    const month = buildFacturaciones(cardId, []).find((f) => f.close_date_iso === days.close)!.billing_month;
    expect(owed.get(month)!.eur).toBeCloseTo(200, 2);
    expect(owed.get(month)!.clp).toBe(0);
  });

  it("lists the euro charge as a euro expense line at the facturación's rate", () => {
    const lines = withLineMoney(buildCcExpenseLines([cardId]));
    const shop = lines.find((l) => l.merchant === "LIBRAIRIE VITEST")!;
    expect(lineAmount(shop)).toEqual({ value: 200, currency: "eur" });
    expect(linePesos(shop)).toBe(204_000);
    expect(shop.values!.clp!.rate_source).toBe("paid");
  });

  it("keys a euro ABONO DE DIVISAS as euro payment evidence", () => {
    const row = listCcPaymentEvidenceRows(cardId).find((r) => r.id === abonoLineId)!;
    expect(row.currency).toBe("eur");
    expect(row.amount_foreign).toBe(50);
    expect(row.key).toBe(ccPaymentEvidenceKey({ cc_account_id: cardId, pago_iso: "2036-03-07", currency: "eur", amount_clp: 0, amount_foreign: 50 }));
    expect(row.key.endsWith("|eur|5000")).toBe(true);
  });
});
