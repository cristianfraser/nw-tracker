import { describe, expect, it, afterEach } from "vitest";
import { db } from "./db.js";
import {
  buildBillingDetailByMonth,
  buildFacturaciones,
  paymentAbonosClpForBillingMonth,
} from "./ccBillingViews.js";
import { creditCardBillingDetailInactive } from "./ccBillingInactive.js";
import {
  ccInstallmentsDbApiPayload,
  ledgerFacturadoClpForBillingMonth,
} from "./ccInstallmentLedgerDb.js";
import { createManualCcInstallmentPurchase } from "./ccInstallmentManual.js";
import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import {
  billingMonthForManualLedgerPurchase,
  lastPdfBillingMonthForAccount,
} from "./ccManualBillingMonth.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import { ymCompare } from "./calendarMonth.js";
import { listCcStatementsForAccount } from "./ccStatementsDb.js";

describe("buildBillingDetailByMonth", () => {
  it("open month rolls prior PDF facturado into total_facturado and balance_total", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    recomputeCcBillingMonthBalances(master.id);
    const payload = ccInstallmentsDbApiPayload(master.id);
    const lastPdf = lastPdfBillingMonthForAccount(master.id);
    const openBm = billingMonthForManualLedgerPurchase(master.id);
    if (!lastPdf || !openBm) return;
    if (ymCompare(openBm, addCalendarMonths(lastPdf, 1)) < 0) return;

    const det = buildBillingDetailByMonth(master.id, payload.months);
    const may = det.find((d) => d.billing_month === lastPdf);
    const openRow = det.find((d) => d.billing_month === openBm);
    if (!may?.total_facturado_clp || !openRow) return;

    expect(openRow.total_facturado_clp).toBeGreaterThanOrEqual(may.total_facturado_clp);
    expect(openRow.balance_total_clp).toBeGreaterThan(may.balance_total_clp * 0.9);
    const incrementalOnly =
      (openRow.total_facturado_clp ?? 0) - (may.total_facturado_clp ?? 0);
    expect(incrementalOnly).toBeGreaterThan(0);
  });

  it("PAGO in open month reduces rolled facturado and balance_total", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const openBm = billingMonthForManualLedgerPurchase(master.id);
    const lastPdf = lastPdfBillingMonthForAccount(master.id);
    if (!openBm || !lastPdf || ymCompare(openBm, lastPdf) <= 0) return;

    const stmt = listCcStatementsForAccount(master.id).find((s) => s.billing_month === openBm);
    if (!stmt) return;

    recomputeCcBillingMonthBalances(master.id);
    const payload = ccInstallmentsDbApiPayload(master.id);
    const before = buildBillingDetailByMonth(master.id, payload.months).find(
      (d) => d.billing_month === openBm
    );
    if (!before) return;

    const pagoClp = 50_000;
    const ins = db
      .prepare(
        `INSERT INTO cc_statement_lines (
           statement_id, transaction_date, merchant, amount_clp, installment_flag, dedupe_key
         ) VALUES (?, ?, 'PAGO', ?, 0, ?)`
      )
      .run(stmt.id, `${openBm}-05`, "PAGO", -pagoClp, `vitest-pago-${Date.now()}`);

    try {
      expect(paymentAbonosClpForBillingMonth(master.id, openBm)).toBeGreaterThanOrEqual(pagoClp);
      const after = buildBillingDetailByMonth(master.id, payload.months).find(
        (d) => d.billing_month === openBm
      );
      expect(after).toBeDefined();
      expect(after!.total_facturado_clp).toBe((before.total_facturado_clp ?? 0) - pagoClp);
      expect(after!.balance_total_clp).toBe(before.balance_total_clp - pagoClp);
    } finally {
      db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`).run(ins.lastInsertRowid);
    }
  });

  it("inactive card omits synthetic open months without imported statements", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|bci|4343'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const stmtCount = (
      db.prepare(`SELECT COUNT(*) AS c FROM cc_statements WHERE account_id = ?`).get(master.id) as {
        c: number;
      }
    ).c;
    if (stmtCount === 0) return;

    expect(creditCardBillingDetailInactive(master.id)).toBe(true);

    recomputeCcBillingMonthBalances(master.id);
    const payload = ccInstallmentsDbApiPayload(master.id);
    const det = buildBillingDetailByMonth(master.id, payload.months);
    expect(det.length).toBeGreaterThan(0);

    const last = det[0]!.billing_month;
    expect(det.every((row) => row.as_of_kind === "statement")).toBe(true);

    const todayMonth = new Date().toISOString().slice(0, 7);
    expect(det.some((row) => row.billing_month >= todayMonth)).toBe(false);
    expect(last < todayMonth).toBe(true);
  });
});

describe("buildFacturaciones", () => {
  it("derives facturado from statement lines when header monto is empty (web paste)", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    recomputeCcBillingMonthBalances(master.id);
    const payload = ccInstallmentsDbApiPayload(master.id);
    const fact = buildFacturaciones(master.id, payload.months);
    const withFacturado = fact.filter((f) => (f.facturado_total_clp ?? 0) > 0);
    if (withFacturado.length === 0) return;
    const row = withFacturado[0]!;
    const det = buildBillingDetailByMonth(master.id, payload.months).find(
      (d) => d.billing_month === row.billing_month
    );
    expect(row.facturado_total_clp).toBeGreaterThan(0);
    expect(row.close_date_iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(det).toBeDefined();
    expect(det!.total_facturado_clp).toBe(row.facturado_total_clp);
  });

  describe("manual installment purchases on open billing month", () => {
    let purchaseId: number | null = null;
    let accountId: number | null = null;

    afterEach(() => {
      if (purchaseId != null && accountId != null) {
        db.prepare(`DELETE FROM cc_installment_purchases WHERE id = ? AND account_id = ?`).run(
          purchaseId,
          accountId
        );
        recomputeCcBillingMonthBalances(accountId);
      }
      purchaseId = null;
      accountId = null;
    });

    it("includes first cuota in open-bucket facturado for Apr 25 manual purchase", () => {
      const master = db
        .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
        .get() as { id: number } | undefined;
      if (!master) return;

      accountId = master.id;
      const purchaseDate = "2026-04-25";
      const principal = 120_000;
      const cuotas = 12;
      const firstCuota = Math.floor(principal / cuotas);

      const lastPdf = lastPdfBillingMonthForAccount(master.id);
      const openBm = billingMonthForManualLedgerPurchase(master.id);
      if (!lastPdf || !openBm) return;
      expect(ymCompare(openBm, addCalendarMonths(lastPdf, 1))).toBeGreaterThanOrEqual(0);

      const before = ledgerFacturadoClpForBillingMonth(master.id, openBm);

      const created = createManualCcInstallmentPurchase(master.id, {
        purchase_date: purchaseDate,
        total_amount_clp: principal,
        cuotas_totales: cuotas,
        merchant: "Test manual facturado",
      });
      purchaseId = created.id;

      expect(ledgerFacturadoClpForBillingMonth(master.id, openBm)).toBe(before + firstCuota);

      recomputeCcBillingMonthBalances(master.id);
    });

    it("includes Mar-dated manual purchase in open-bucket facturado", () => {
      const master = db
        .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
        .get() as { id: number } | undefined;
      if (!master) return;

      accountId = master.id;
      const firstCuota = 15_000;
      const lastPdf = lastPdfBillingMonthForAccount(master.id);
      const openBm = billingMonthForManualLedgerPurchase(master.id);
      if (!lastPdf || !openBm) return;
      const before = ledgerFacturadoClpForBillingMonth(master.id, openBm);

      const created = createManualCcInstallmentPurchase(master.id, {
        purchase_date: "2026-03-15",
        total_amount_clp: 60_000,
        cuotas_totales: 4,
        merchant: "Test manual Mar open bucket",
      });
      purchaseId = created.id;

      expect(ledgerFacturadoClpForBillingMonth(master.id, openBm)).toBe(before + firstCuota);
    });
  });
});
