import { describe, expect, it, afterEach } from "vitest";
import { db } from "./db.js";
import { buildFacturaciones, buildBillingDetailByMonth } from "./ccBillingViews.js";
import { creditCardBillingDetailInactive } from "./ccBillingInactive.js";
import {
  ccInstallmentsDbApiPayload,
  ledgerFacturadoClpForBillingMonth,
} from "./ccInstallmentLedgerDb.js";
import { createManualCcInstallmentPurchase } from "./ccInstallmentManual.js";
import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import { billingMonthForManualLedgerPurchase } from "./ccManualBillingMonth.js";

describe("buildBillingDetailByMonth", () => {
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
    const may = fact.find((f) => f.billing_month === "2026-05");
    const det = buildBillingDetailByMonth(master.id, payload.months).find(
      (d) => d.billing_month === "2026-05"
    );
    expect(may).toBeDefined();
    expect(may!.facturado_total_clp).toBeGreaterThan(0);
    expect(may!.close_date_iso).toBe("2026-05-20");
    expect(det).toBeDefined();
    expect(det!.total_facturado_clp).toBe(may!.facturado_total_clp);
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

      const openBm = billingMonthForManualLedgerPurchase(master.id);
      expect(openBm).toBeTruthy();

      const before = ledgerFacturadoClpForBillingMonth(master.id, openBm!);

      const created = createManualCcInstallmentPurchase(master.id, {
        purchase_date: purchaseDate,
        total_amount_clp: principal,
        cuotas_totales: cuotas,
        merchant: "Test manual facturado",
      });
      purchaseId = created.id;

      expect(ledgerFacturadoClpForBillingMonth(master.id, openBm!)).toBe(before + firstCuota);

      recomputeCcBillingMonthBalances(master.id);
    });

    it("includes Mar-dated manual purchase in open-bucket facturado", () => {
      const master = db
        .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
        .get() as { id: number } | undefined;
      if (!master) return;

      accountId = master.id;
      const firstCuota = 15_000;
      const openBm = billingMonthForManualLedgerPurchase(master.id);
      expect(openBm).toBeTruthy();
      const before = ledgerFacturadoClpForBillingMonth(master.id, openBm!);

      const created = createManualCcInstallmentPurchase(master.id, {
        purchase_date: "2026-03-15",
        total_amount_clp: 60_000,
        cuotas_totales: 4,
        merchant: "Test manual Mar open bucket",
      });
      purchaseId = created.id;

      expect(ledgerFacturadoClpForBillingMonth(master.id, openBm!)).toBe(before + firstCuota);
    });
  });
});
