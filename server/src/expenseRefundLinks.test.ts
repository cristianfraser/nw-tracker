import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { applyListing, listingCard, listingLine } from "./test/cardListingPayloads.js";
import { snapshotTables } from "./test/snapshotTables.js";
import { createTempCardMaster, deleteTempCardMaster } from "./test/tempCardMaster.js";
import { insertLines } from "./cards/lineWrites.js";
import { annulOpenBucketLines } from "./ccAnnulledPurchases.js";
import { createManualCcInstallmentPurchase } from "./ccInstallmentManual.js";
import { buildFlowsExpenseLines } from "./flowsExpenses.js";
import { storePaymentProcessorReceipts } from "./paymentProcessorReceipts.js";
import { toWireExpenseLine } from "./wireExpenseLine.js";

const restoreDerivedCardState = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_metrics"]);
afterAll(() => restoreDerivedCardState());

const PRINCIPAL = 71_300;
const PURCHASE = "2026-11-05";
const PAID = "2026-11-13";
const RECEIPT_ID = "<vitest-refund-links-ml@test>";

describe("refunds linked to their purchase", () => {
  describe("a plan the bank prepaid and a nota paired by the nota pairing", () => {
    const LAST4 = "9966";
    const BANK_ACCOUNT = "800099990066";
    let accountId = 0;
    let tmpDir = "";
    let feedSeq = 0;
    const prevIdentifiers = process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS;

    const addPlan = (merchant: string) =>
      createManualCcInstallmentPurchase(accountId, {
        purchase_date: PURCHASE,
        total_amount_clp: PRINCIPAL,
        cuotas_totales: 6,
        merchant,
        card_group: "santander",
      }).id;

    function feed(lines: ReturnType<typeof listingLine>[]) {
      applyListing(
        { observed_at: "2026-11-14T01:00:00.000Z", cards: [listingCard(BANK_ACCOUNT, lines, { date: "2026-10-23", clp: 500_000, usd: 0 })] },
        `card-movements-vitest-refund-links-${++feedSeq}.json`
      );
      clearAggregationCache();
    }
    const prepago = (merchant = "VITEST MERCADOPAGO NT") => ({ ...listingLine(PAID, merchant, PRINCIPAL, { raw: "PREPAGO EN CUOTAS" }), plan_prepayment: true as const });
    const credit = (merchant = "VITEST MERCADOPAGO NT") => ({ ...listingLine(PURCHASE, merchant, -PRINCIPAL, { raw: "NOTA DE CREDITO" }), credit_note: true as const });
    const lines = () => buildFlowsExpenseLines([accountId]).filter((l) => l.account_id === accountId);

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-14T15:00:00Z"));
      accountId = createTempCardMaster({ issuer: "santander", last4: LAST4, key: `vitest-refund-links-${LAST4}` });
      const insert = db.prepare(
        `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, card_last4, layout, currency, monto_facturado, next_period_from, next_period_to)
         VALUES (?, 'santander', ?, '23/10/2026', '24/09/2026', '23/10/2026', ?, 'compact', ?, ?, '23/10/2026', '23/11/2026')`
      );
      insert.run(accountId, "vitest 2026-10-23 clp.pdf", LAST4, "clp", 500_000);
      insert.run(accountId, "vitest 2026-10-23 usd.pdf", LAST4, "usd", 0);
      db.prepare(`INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, '2026-10-30', 500000, 'clp')`).run(accountId);
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-refund-links-"));
      const identifiers = path.join(tmpDir, "organize-identifiers.json");
      fs.writeFileSync(identifiers, JSON.stringify({ santander_80_account_to_card_last4: { [BANK_ACCOUNT]: LAST4 } }));
      process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS = identifiers;
      clearAggregationCache();
    });

    afterEach(() => {
      vi.useRealTimers();
      db.prepare(`DELETE FROM payment_processor_receipts WHERE message_id = ?`).run(RECEIPT_ID);
      db.prepare(`DELETE FROM cc_bank_cupo_captures WHERE source_file LIKE 'card-movements-vitest-refund-links-%'`).run();
      db.prepare(`DELETE FROM import_batches WHERE raw_text LIKE ?`).run(`%"account_id":${accountId},%`);
      deleteTempCardMaster(accountId);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (prevIdentifiers == null) delete process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS;
      else process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS = prevIdentifiers;
      clearAggregationCache();
    });

    it("the credit of a prepaid plan refunds the plan's purchase line; nothing server-only leaks", () => {
      addPlan("VITEST MERCADO");
      feed([credit(), prepago()]);
      const all = lines();
      const total = all.find((l) => l.line_role === "installment_purchase_total")!;
      const refund = all.find((l) => l.amount!.value < 0)!;
      expect(refund.refund_of).toMatchObject({
        line_id: total.statement_line_id,
        purchase_key: total.purchase_key,
        purchase_date: PURCHASE,
        merchant: total.merchant,
      });
      expect(total.refund_of).toBeUndefined();
      for (const l of all) expect(l.refund_of_line_id).toBeUndefined();
      expect(toWireExpenseLine(refund, "clp")).not.toHaveProperty("refund_of_line_id");
    });

    it("a nota the nota pairing matched refunds its purchase", () => {
      feed([listingLine("2026-11-02", "VITEST SHOP", 20_000), { ...listingLine("2026-11-04", "VITEST NOTA DE CREDITO", -20_000, { raw: "NOTA DE CREDITO" }), credit_note: true as const }]);
      const all = lines();
      const purchase = all.find((l) => l.merchant === "VITEST SHOP")!;
      const nota = all.find((l) => l.amount!.value < 0 && l.nota_credito_role === "matched_nota")!;
      expect(nota.refund_of).toMatchObject({ line_id: purchase.statement_line_id, purchase_key: purchase.purchase_key, purchase_date: "2026-11-02" });
      expect(purchase.refund_of).toBeUndefined();
    });

    it("a paired refund under another merchant does not change the purchase's name", () => {
      // «MP *MERCADO LIBRE» is the catalog's MercadoLibre; the plan prints the cut «MP *MERCADO».
      addPlan("MP *MERCADO");
      feed([listingLine("2026-11-06", "MP *MERCADO LIBRE", 9_000)]);
      const before = lines().find((l) => l.line_role === "installment_purchase_total")!;
      expect(before.display_merchant).toBe("Mercadolibre (Chile)");
      feed([credit("MP *MERCADOPAGO NT"), prepago("MP *MERCADOPAGO NT")]);
      const total = lines().find((l) => l.line_role === "installment_purchase_total")!;
      expect(total.display_merchant).toBe("Mercadolibre (Chile)");
      const refund = lines().find((l) => l.amount!.value < 0)!;
      expect(refund.refund_of?.display_merchant).toBe("Mercadolibre (Chile)");
    });

    it("an amountless MercadoLibre receipt links the plan's line, and the refund copies the purchase's receipt", () => {
      addPlan("MP *MERCADO");
      storePaymentProcessorReceipts({
        receipts: [
          {
            message_id: RECEIPT_ID,
            sent_at_chile: "2026-11-05 15:05",
            processor: "mercadolibre",
            payee: { name: "Tienda Prueba SpA", rut: null, email: null },
            amount: null,
            currency: "clp",
            paid_at_chile: "2026-11-05 15:03",
            order_ref: null,
            concept: "Producto",
            statement_descriptor: null,
            payment_method: null,
            installments: null,
            charges: null,
          },
        ],
      });
      feed([credit("MP *MERCADOPAGO NT"), prepago("MP *MERCADOPAGO NT")]);
      const all = lines();
      const total = all.find((l) => l.line_role === "installment_purchase_total")!;
      expect(total.payment_receipt?.processor).toBe("mercadolibre");
      expect(total.display_merchant).toBe("Mercadolibre (Chile)");
      expect(total.link_label?.text).toBe("Tienda Prueba");
      const refund = all.find((l) => l.amount!.value < 0)!;
      expect(refund.payment_receipt).toBeUndefined();
      expect(refund.refund_of?.payment_receipt).toEqual(total.payment_receipt);
      expect(refund.refund_of?.link_label).toEqual(total.link_label);
    });
  });

  describe("an annulled purchase", () => {
    let accountId = 0;
    beforeEach(() => {
      accountId = createTempCardMaster({ issuer: "santander", last4: "7744", key: "vitest-refund-links-annul" });
    });
    afterEach(() => {
      deleteTempCardMaster(accountId);
      clearAggregationCache();
    });

    it("its annulment refunds the purchase line", () => {
      insertLines(accountId, {
        lines: [{ transaction_date: "2026-11-02", merchant: "VITEST VOIDED SHOP", currency: "clp" as const, amount: 80_000, raw_line: "voided" }],
        errors: [],
      });
      const lineId = (db.prepare(`SELECT l.id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ?`).get(accountId) as { id: number }).id;
      const { plan } = annulOpenBucketLines(accountId, [lineId], { annulledOn: "2026-11-05", basis: "manual", evidence: null });
      db.prepare(`DELETE FROM cc_statement_lines WHERE id IN (${plan.deleteLineIds.join(",")})`).run();
      clearAggregationCache();
      const all = buildFlowsExpenseLines([accountId]).filter((l) => l.account_id === accountId);
      const purchase = all.find((l) => l.annulled != null)!;
      const annulment = all.find((l) => l.annulment != null)!;
      expect(annulment.refund_of).toMatchObject({ line_id: purchase.statement_line_id, purchase_key: purchase.purchase_key, purchase_date: "2026-11-02", merchant: "VITEST VOIDED SHOP" });
      expect(purchase.refund_of).toBeUndefined();
    });
  });
});
