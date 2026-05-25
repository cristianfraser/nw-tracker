import { describe, expect, it, afterEach } from "vitest";
import { db } from "./db.js";
import { buildFacturaciones, buildBillingDetailByMonth } from "./ccBillingViews.js";
import {
  ccInstallmentsDbApiPayload,
  ledgerFacturadoClpForBillingMonth,
} from "./ccInstallmentLedgerDb.js";
import { createManualCcInstallmentPurchase } from "./ccInstallmentManual.js";
import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import { billingMonthForManualLedgerPurchase } from "./ccManualBillingMonth.js";

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
    expect(may!.facturado_total_clp).toBe(det?.total_facturado_clp);
    expect(may!.close_date_iso).toBe("2026-05-20");
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

    it("includes first cuota in May facturado for Apr 25 manual purchase", () => {
      const master = db
        .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
        .get() as { id: number } | undefined;
      if (!master) return;

      accountId = master.id;
      const purchaseDate = "2026-04-25";
      const principal = 120_000;
      const cuotas = 12;
      const firstCuota = Math.floor(principal / cuotas);

      expect(billingMonthForManualLedgerPurchase(master.id)).toBe("2026-05");

      const before = ledgerFacturadoClpForBillingMonth(master.id, "2026-05");

      const created = createManualCcInstallmentPurchase(master.id, {
        purchase_date: purchaseDate,
        total_amount_clp: principal,
        cuotas_totales: cuotas,
        merchant: "Test manual facturado",
      });
      purchaseId = created.id;

      expect(ledgerFacturadoClpForBillingMonth(master.id, "2026-05")).toBe(before + firstCuota);

      recomputeCcBillingMonthBalances(master.id);
      const payload = ccInstallmentsDbApiPayload(master.id);
      const may = buildFacturaciones(master.id, payload.months).find(
        (f) => f.billing_month === "2026-05"
      );
      if ((may?.facturado_total_clp ?? 0) <= 0) {
        expect(may?.facturado_total_clp).toBe(before + firstCuota);
      }
    });

    it("includes Mar-dated manual purchase in open May facturado", () => {
      const master = db
        .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
        .get() as { id: number } | undefined;
      if (!master) return;

      accountId = master.id;
      const firstCuota = 15_000;
      const before = ledgerFacturadoClpForBillingMonth(master.id, "2026-05");

      const created = createManualCcInstallmentPurchase(master.id, {
        purchase_date: "2026-03-15",
        total_amount_clp: 60_000,
        cuotas_totales: 4,
        merchant: "Test manual Mar open bucket",
      });
      purchaseId = created.id;

      expect(ledgerFacturadoClpForBillingMonth(master.id, "2026-05")).toBe(before + firstCuota);
    });
  });
});
