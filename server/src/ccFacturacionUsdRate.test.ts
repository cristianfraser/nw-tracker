import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import { clearAggregationCache } from "./aggregationCache.js";
import { buildBillingDetailByMonth, buildFacturaciones } from "./ccBillingViews.js";
import { facturacionUsdRates, usdDebtPaymentsForAccount } from "./ccFacturacionUsdRate.js";
import { relinkCcTraspasoDeudaLinksForAccount } from "./ccTraspasoDeudaLinks.js";
import { buildCcExpenseLines } from "./flowsCreditCardExpenses.js";
import { fxMonthEndForBalanceUsd } from "./fxRates.js";

describe("facturacionUsdRates", () => {
  const rows = [
    { billing_month: "2026-07", close_date_iso: "2026-07-23", pay_by_iso: "2026-08-10" },
    { billing_month: "2026-08", close_date_iso: "2026-08-25", pay_by_iso: "2026-09-09" },
    { billing_month: "2026-09", close_date_iso: "2026-09-24", pay_by_iso: "2026-10-09" },
  ];
  const rates = (payments: { date_iso: string; clp: number; usd: number }[], todayYmd = "2026-09-26") => {
    let liveCalls = 0;
    const out = facturacionUsdRates(rows, payments, {
      todayYmd,
      payByRate: (payByIso) => (payByIso === "2026-08-10" ? 930 : 940),
      liveRate: () => {
        liveCalls += 1;
        return 950;
      },
    });
    return { out, liveCalls };
  };

  it("uses the weighted rate of the payments made after the close, up to the next close", () => {
    const { out } = rates([
      { date_iso: "2026-09-08", clp: 400_000, usd: 400 },
      { date_iso: "2026-09-20", clp: 190_000, usd: 200 },
    ]);
    expect(out.get("2026-08")).toEqual({ clp_per_usd: 590_000 / 600, source: "paid", paid_usd: 600 });
  });

  it("a payment on a close day pays the previous facturación", () => {
    const { out } = rates([{ date_iso: "2026-08-25", clp: 93_000, usd: 100 }]);
    expect(out.get("2026-07")).toEqual({ clp_per_usd: 930, source: "paid", paid_usd: 100 });
    expect(out.get("2026-08")?.source).toBe("pay_by");
  });

  it("without payments: the pay-by rate once the pay-by passed, today's rate until then (the pay-by day included)", () => {
    const { out, liveCalls } = rates([]);
    expect(out.get("2026-07")).toEqual({ clp_per_usd: 930, source: "pay_by", paid_usd: 0 });
    expect(out.get("2026-08")).toEqual({ clp_per_usd: 940, source: "pay_by", paid_usd: 0 });
    expect(out.get("2026-09")).toEqual({ clp_per_usd: 950, source: "live", paid_usd: 0 });
    expect(liveCalls).toBe(1);
    expect(rates([], "2026-09-09").out.get("2026-08")?.source).toBe("live");
  });

  it("refuses two facturaciones on one close", () => {
    expect(() =>
      facturacionUsdRates(
        [rows[0]!, { ...rows[1]!, close_date_iso: "2026-07-23" }],
        [],
        { todayYmd: "2026-09-26", payByRate: () => 1, liveRate: () => 1 }
      )
    ).toThrow(/share the close/);
  });
});

/**
 * Synthetic card with dollars on July (paid by nothing on file), August (paid by a divisas
 * purchase after its close) and September (closed, not paid yet): each facturación's row and its
 * expense lines show the same rate, while the detalle keeps the debt frame (pay-by − 1).
 */
describe("facturación dollars at the rate actually paid", () => {
  let accountId = 0;
  let checkingId = 0;
  const LAST4 = "9922";

  function insertStatement(date: string, from: string, to: string, currency: "clp" | "usd", monto: number, payBy: string) {
    return Number(
      db
        .prepare(
          `INSERT INTO cc_statements (
             account_id, card_group, source_pdf, statement_date, period_from, period_to,
             card_last4, layout, currency, monto_facturado, pay_by
           ) VALUES (?, 'santander', ?, ?, ?, ?, ?, 'compact', ?, ?, ?)`
        )
        .run(accountId, `vitest-usd-rate ${date} ${currency}.pdf`, date, from, to, LAST4, currency, monto, payBy)
          .lastInsertRowid
    );
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T15:00:00Z"));
    const bucket = db
      .prepare(`SELECT id FROM asset_groups WHERE slug IN ('credit_card', 'credit_cards__credit_card') LIMIT 1`)
      .get() as { id: number };
    const importKey = `credit_card_master|santander|vitest-usd-rate-${LAST4}`;
    accountId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · usd rate', ?, ?)`)
        .run(bucket.id, importKey, importKey).lastInsertRowid
    );
    checkingId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · usd rate checking', 'vitest-usd-rate-checking', 'vitest-usd-rate-checking')`)
        .run(bucket.id).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4)
       VALUES (?, 21, 20, ?)`
    ).run(accountId, LAST4);
    insertStatement("23/07/2026", "23/06/2026", "23/07/2026", "clp", 100_000, "10/08/2026");
    insertStatement("23/07/2026", "23/06/2026", "23/07/2026", "usd", 705.5, "10/08/2026");
    insertStatement("25/08/2026", "23/07/2026", "25/08/2026", "clp", 200_000, "09/09/2026");
    const augustUsd = insertStatement("25/08/2026", "23/07/2026", "25/08/2026", "usd", 556.21, "09/09/2026");
    insertStatement("24/09/2026", "25/08/2026", "24/09/2026", "clp", 300_000, "09/10/2026");
    insertStatement("24/09/2026", "25/08/2026", "24/09/2026", "usd", 1138.53, "09/10/2026");
    db.prepare(
      `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp, amount_usd, installment_flag, dedupe_key, raw_line)
       VALUES (?, '10/08/2026', 'VITEST USD SHOP', 0, 100, 0, 'vitest-usd-rate-shop', 'vitest')`
    ).run(augustUsd);
    // The August dollars, bought and credited on 2026-09-08 at 942,30 CLP/USD.
    db.prepare(
      `INSERT INTO movements (from_account_id, to_account_id, amount, currency, counter_amount, counter_currency, occurred_on, note, flow_kind)
       VALUES (?, ?, 524117, 'clp', 556.21, 'usd', '2026-09-08', 'vitest-usd-rate-divisas', 'pago_tarjeta')`
    ).run(checkingId, accountId);
    clearAggregationCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.prepare(`DELETE FROM movements WHERE from_account_id = ? OR to_account_id = ?`).run(checkingId, accountId);
    db.prepare(`DELETE FROM cc_billing_month_balances WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id IN (?, ?)`).run(accountId, checkingId);
    clearAggregationCache();
  });

  it("reads the divisas purchase as a dollar debt payment", () => {
    expect(usdDebtPaymentsForAccount(accountId)).toEqual([{ date_iso: "2026-09-08", clp: 524117, usd: 556.21 }]);
  });

  it("each facturación's row shows its dollars at its own rate", () => {
    const byMonth = new Map(buildFacturaciones(accountId, []).map((f) => [f.billing_month, f]));
    const august = byMonth.get("2026-08")!;
    expect(august.usd_rate_source).toBe("paid");
    expect(august.facturado_usd_clp).toBe(524117);
    expect(august.facturado_total_clp).toBe(200_000 + 524117);

    const july = byMonth.get("2026-07")!;
    const julyRate = fxMonthEndForBalanceUsd("2026-08-09")!.clp_per_usd;
    expect(july.usd_rate_source).toBe("pay_by");
    expect(july.facturado_usd_clp).toBe(Math.round(705.5 * julyRate));

    const september = byMonth.get("2026-09")!;
    expect(september.usd_rate_source).toBe("live");
    expect(september.facturado_usd_clp).toBe(Math.round(1138.53 * september.usd_rate_clp!));
  });

  it("the expense lines of a facturación use the rate its row shows", () => {
    const line = buildCcExpenseLines([accountId]).find((l) => l.merchant === "VITEST USD SHOP");
    expect(line?.amount_clp).toBe(Math.round(100 * (524117 / 556.21)));
  });

  it("the detalle keeps valuing the debt at pay-by − 1", () => {
    const august = buildBillingDetailByMonth(accountId, []).find((r) => r.billing_month === "2026-08");
    const debtRate = fxMonthEndForBalanceUsd("2026-09-08")!.clp_per_usd;
    expect(august?.total_facturado_clp).toBe(200_000 + Math.round(556.21 * debtRate));
  });
});

/**
 * Synthetic card whose dollar payments are printed on the statement after the facturación they pay:
 * July's US$xxx is paid on the August statement by two divisas purchases paired with their ABONO DE
 * DIVISAS lines and a traspaso de deuda; August's US$xxx by a divisas purchase on 2026-09-08 whose
 * ABONO DE DIVISAS on the September statement carries no pairing. September (US$xxx) is unpaid.
 */
describe("dollar payment lines show the pesos actually paid for them", () => {
  let accountId = 0;
  let checkingId = 0;
  const LAST4 = "9924";
  const statementIds: Record<string, number> = {};

  function insertStatement(date: string, from: string, to: string, currency: "clp" | "usd", monto: number, payBy: string) {
    const id = Number(
      db
        .prepare(
          `INSERT INTO cc_statements (
             account_id, card_group, source_pdf, statement_date, period_from, period_to,
             card_last4, layout, currency, monto_facturado, pay_by
           ) VALUES (?, 'santander', ?, ?, ?, ?, ?, 'compact', ?, ?, ?)`
        )
        .run(accountId, `vitest-usd-payment ${date} ${currency}.pdf`, date, from, to, LAST4, currency, monto, payBy)
          .lastInsertRowid
    );
    statementIds[`${date} ${currency}`] = id;
    return id;
  }

  function insertLine(statement: string, date: string, merchant: string, amount: { clp?: number; usd?: number }): number {
    return Number(
      db
        .prepare(
          `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp, amount_usd, installment_flag, dedupe_key, raw_line)
           VALUES (?, ?, ?, ?, ?, 0, ?, 'vitest')`
        )
        .run(
          statementIds[statement],
          date,
          merchant,
          amount.clp ?? 0,
          amount.usd ?? null,
          `vitest-usd-payment|${statement}|${merchant}|${date}|${amount.clp ?? amount.usd}`
        ).lastInsertRowid
    );
  }

  /** A divisas purchase checking → card; `pairedLineId` pairs it with its ABONO DE DIVISAS line. */
  function insertDivisas(date: string, clp: number, usd: number, pairedLineId: number | null): number {
    const id = Number(
      db
        .prepare(
          `INSERT INTO movements (from_account_id, to_account_id, amount, currency, counter_amount, counter_currency, occurred_on, note, flow_kind)
           VALUES (?, ?, ?, 'clp', ?, 'usd', ?, 'vitest-usd-payment-divisas', 'pago_tarjeta')`
        )
        .run(checkingId, accountId, clp, usd, date).lastInsertRowid
    );
    if (pairedLineId != null) pair(id, pairedLineId, date, clp);
    return id;
  }

  function pair(transferId: number, lineId: number, date: string, clp: number): void {
    db.prepare(
      `INSERT INTO movement_mirror_merges (
         transfer_movement_id, out_movement_id, out_occurred_on, out_amount_clp,
         in_statement_line_id, in_occurred_on, in_amount_clp
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(transferId, transferId, date, -clp, lineId, date, -clp);
  }

  const lineIds: Record<string, number> = {};
  let augustDivisasId = 0;

  function linesById() {
    return new Map(buildCcExpenseLines([accountId]).map((l) => [l.statement_line_id, l]));
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T15:00:00Z"));
    const bucket = db
      .prepare(`SELECT id FROM asset_groups WHERE slug IN ('credit_card', 'credit_cards__credit_card') LIMIT 1`)
      .get() as { id: number };
    const importKey = `credit_card_master|santander|vitest-usd-payment-${LAST4}`;
    accountId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · usd payment', ?, ?)`)
        .run(bucket.id, importKey, importKey).lastInsertRowid
    );
    checkingId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · usd payment checking', 'vitest-usd-payment-checking', 'vitest-usd-payment-checking')`)
        .run(bucket.id).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4)
       VALUES (?, 21, 20, ?)`
    ).run(accountId, LAST4);
    insertStatement("23/07/2026", "23/06/2026", "23/07/2026", "clp", 100_000, "10/08/2026");
    insertStatement("23/07/2026", "23/06/2026", "23/07/2026", "usd", 700, "10/08/2026");
    insertStatement("25/08/2026", "23/07/2026", "25/08/2026", "clp", 486_000, "09/09/2026");
    insertStatement("25/08/2026", "23/07/2026", "25/08/2026", "usd", 500, "09/09/2026");
    insertStatement("24/09/2026", "25/08/2026", "24/09/2026", "clp", 300_000, "09/10/2026");
    insertStatement("24/09/2026", "25/08/2026", "24/09/2026", "usd", 100, "09/10/2026");

    // August's own charges (its CLP header 4xx.xxx = traspaso cargo + shop; its US$xxx = the shop).
    lineIds.traspasoClp = insertLine("25/08/2026 clp", "09/08/2026", "TRASPASO A DEUDA NACIONAL", { clp: 192_000 });
    lineIds.augustShopClp = insertLine("25/08/2026 clp", "12/08/2026", "VITEST CLP SHOP", { clp: 294_000 });
    lineIds.augustShopUsd = insertLine("25/08/2026 usd", "10/08/2026", "VITEST USD SHOP", { usd: 500 });
    // July's US$700, paid after its close: 400 + 100 by divisas, 200 moved to the peso side.
    lineIds.abonoPaired = insertLine("25/08/2026 usd", "07/08/2026", "ABONO DE DIVISAS", { usd: -400 });
    lineIds.abonoProRata = insertLine("25/08/2026 usd", "15/08/2026", "ABONO DE DIVISAS", { usd: -100 });
    lineIds.traspasoUsd = insertLine("25/08/2026 usd", "09/08/2026", "TRASPASO DE DEUDA INTERNACIONAL", { usd: -200 });
    // September: its own charge and credit, and the (unpaired) payment of August's dollars.
    lineIds.septemberShopUsd = insertLine("24/09/2026 usd", "10/09/2026", "VITEST USD SHOP 2", { usd: 100 });
    lineIds.septemberNota = insertLine("24/09/2026 usd", "12/09/2026", "NOTA DE CREDITO", { usd: -20 });
    lineIds.abonoUnpaired = insertLine("24/09/2026 usd", "08/09/2026", "ABONO DE DIVISAS", { usd: -500 });

    insertDivisas("2026-08-07", 372_000, 400, lineIds.abonoPaired);
    // Paired with a line of fewer dollars than it bought: the line takes its share.
    insertDivisas("2026-08-15", 190_000, 200, lineIds.abonoProRata);
    augustDivisasId = insertDivisas("2026-09-08", 470_000, 500, null);
    relinkCcTraspasoDeudaLinksForAccount(accountId);
    clearAggregationCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.prepare(`DELETE FROM movements WHERE from_account_id = ? OR to_account_id = ?`).run(checkingId, accountId);
    db.prepare(`DELETE FROM cc_traspaso_deuda_links WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM cc_billing_month_balances WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id IN (?, ?)`).run(accountId, checkingId);
    for (const k of Object.keys(lineIds)) delete lineIds[k];
    for (const k of Object.keys(statementIds)) delete statementIds[k];
    clearAggregationCache();
  });

  it("a divisas purchase paired with the line: its pesos, pro rata on the dollars", () => {
    const lines = linesById();
    expect(lines.get(lineIds.abonoPaired!)?.amount_clp).toBe(-372_000);
    expect(lines.get(lineIds.abonoProRata!)?.amount_clp).toBe(-95_000);
  });

  it("a traspaso de deuda's USD leg: minus its CLP leg", () => {
    const lines = linesById();
    expect(lines.get(lineIds.traspasoUsd!)?.amount_clp).toBe(-192_000);
    expect(lines.get(lineIds.traspasoClp!)?.amount_clp).toBe(192_000);
  });

  it("otherwise the rate of the facturación it paid, not of the one whose statement prints it", () => {
    const byMonth = new Map(buildFacturaciones(accountId, []).map((f) => [f.billing_month, f]));
    const august = byMonth.get("2026-08")!;
    expect(august.usd_rate_source).toBe("paid");
    const september = byMonth.get("2026-09")!;
    expect(september.usd_rate_source).toBe("live");
    expect(september.usd_rate_clp).not.toBe(940);
    const abono = linesById().get(lineIds.abonoUnpaired!)!;
    expect(abono.billing_month).toBe("2026-09");
    // What August's row shows was paid for its dollars.
    expect(abono.amount_clp).toBe(-august.facturado_usd_clp!);
    expect(abono.amount_clp).toBe(-470_000);
  });

  it("a payment on a close day pays the facturación that closed before it", () => {
    const closeDay = insertLine("24/09/2026 usd", "25/08/2026", "ABONO DE DIVISAS", { usd: -10 });
    const july = buildFacturaciones(accountId, []).find((f) => f.billing_month === "2026-07")!;
    expect(july.usd_rate_clp).toBe((372_000 + 190_000 + 192_000) / 800);
    expect(linesById().get(closeDay)?.amount_clp).toBe(Math.round(-10 * july.usd_rate_clp!));
  });

  it("charges and credits that are not payments keep their facturación's rate, and the rows add up", () => {
    const byMonth = new Map(buildFacturaciones(accountId, []).map((f) => [f.billing_month, f]));
    const septemberRate = byMonth.get("2026-09")!.usd_rate_clp!;
    const lines = linesById();
    expect(lines.get(lineIds.septemberNota!)?.amount_clp).toBe(Math.round(-20 * septemberRate));
    expect(lines.get(lineIds.septemberShopUsd!)?.amount_clp).toBe(Math.round(100 * septemberRate));
    expect(lines.get(lineIds.augustShopUsd!)?.amount_clp).toBe(500 * 940);
    // August's charges are its row; the payments it prints settle July, outside the row.
    const augustCharges = [...lines.values()]
      .filter((l) => l.billing_month === "2026-08" && l.amount_clp > 0)
      .reduce((s, l) => s + l.amount_clp, 0);
    expect(augustCharges).toBe(byMonth.get("2026-08")!.facturado_total_clp);
  });

  it("throws on a payment line dated before the card's first close", () => {
    insertLine("23/07/2026 usd", "10/07/2026", "ABONO DE DIVISAS", { usd: -10 });
    expect(() => buildCcExpenseLines([accountId])).toThrow(/precedes every facturación close/);
  });

  it("throws on a pairing whose purchase is dated on another day than its line", () => {
    pair(augustDivisasId, lineIds.abonoPaired!, "2026-09-08", 470_000);
    expect(() => buildCcExpenseLines([accountId])).toThrow(/stale movement_mirror_merges/);
  });
});
