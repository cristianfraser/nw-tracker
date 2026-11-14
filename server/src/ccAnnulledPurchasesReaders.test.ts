import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { snapshotTables } from "./test/snapshotTables.js";
import { createTempCardMaster, deleteTempCardMaster } from "./test/tempCardMaster.js";
import { insertLines } from "./cards/lineWrites.js";
import { annulOpenBucketLines } from "./ccAnnulledPurchases.js";
import { ccOwedByCurrencyAtYmd } from "./ccOwedWalk.js";
import { ccOwedByCurrency } from "./ccOwedByCurrency.js";
import { postCloseLiveBalanceAdjustmentClp, normalizedPostCloseLines } from "./ccBillingBalances.js";
import { ccFinancingCostClpByDate } from "./ccFinancingCostDaily.js";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import { buildFlowsExpenseLines } from "./flowsExpenses.js";
import { aggregateGastosFromLines } from "./flowsExpensesGastos.js";
import { flowLinesForFacturacionMonth } from "./flowsExpenseLineLists.js";
import { latestMovementRows } from "./latestMovements.js";
import { assignFlowExpenseLineCategory } from "./expenseAssignmentWrites.js";
import { annulledPurchaseLineId } from "./ccAnnulledPurchasesRead.js";
import { InputError } from "./inputError.js";
import { parseExpenseKey } from "./expenseKeys.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { listCcExpenseCategories } from "./ccExpenseCategories.js";
import type { FlowsOverviewIncome } from "./flowsOverview.js";

const restoreDerivedCardState = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_metrics"]);
afterAll(() => restoreDerivedCardState());

const PURCHASE = "2026-11-02";
const ANNULLED = "2026-11-05";
const ANCHOR = "2026-10-30";

describe("annulled purchases: readers", () => {
  let accountId = 0;

  function insertAnnulled(over: Partial<{ currency: string; amount: number; merchant: string; key: string | null; purchase: string; annulled: string }> = {}): number {
    return Number(
      db
        .prepare(
          `INSERT INTO cc_annulled_purchases (account_id, currency, amount, merchant, purchase_date, annulled_on, basis, parser_row_id)
           VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)`
        )
        .run(
          accountId,
          over.currency ?? "clp",
          over.amount ?? 80_000,
          over.merchant ?? "VITEST ANNULLED SHOP",
          over.purchase ?? PURCHASE,
          over.annulled ?? ANNULLED,
          over.key ?? null
        ).lastInsertRowid
    );
  }

  function anchor(value: number): void {
    db.prepare(`INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')`).run(accountId, ANCHOR, value);
    clearAggregationCache();
  }

  const owedClp = (day: string) => ccOwedByCurrencyAtYmd(accountId, day, { strictlyBefore: false })!.owed.clp;

  beforeEach(() => {
    accountId = createTempCardMaster({ issuer: "santander", last4: "7722", key: "vitest-annul-readers" });
  });
  afterEach(() => {
    deleteTempCardMaster(accountId);
    clearAggregationCache();
  });

  it("the owed walk rises on the purchase day and falls on the annulment day, never before or after", () => {
    anchor(100_000);
    insertAnnulled();
    expect(owedClp("2026-11-01")).toBe(100_000);
    expect(owedClp(PURCHASE)).toBe(180_000);
    expect(owedClp("2026-11-04")).toBe(180_000);
    expect(owedClp(ANNULLED)).toBe(100_000);
    expect(owedClp("2026-11-10")).toBe(100_000);
  });

  it("the cached evidence stream follows a new row without a manual cache clear (mark trigger)", () => {
    anchor(100_000);
    expect(normalizedPostCloseLines(accountId).filter((e) => e.key.startsWith("annulled|"))).toHaveLength(0);
    expect(owedClp("2026-11-03")).toBe(100_000);
    insertAnnulled();
    expect(normalizedPostCloseLines(accountId).filter((e) => e.key.startsWith("annulled|"))).toHaveLength(2);
    expect(owedClp("2026-11-03")).toBe(180_000);
    db.prepare(`DELETE FROM cc_annulled_purchases WHERE account_id = ?`).run(accountId);
    expect(owedClp("2026-11-03")).toBe(100_000);
  });

  it("a purchase annulled the day it was made nets to nothing", () => {
    anchor(100_000);
    insertAnnulled({ annulled: PURCHASE });
    expect(owedClp(PURCHASE)).toBe(100_000);
  });

  it("a dollar annulment moves the dollar sub-balance, not the pesos", () => {
    anchor(100_000);
    insertAnnulled({ currency: "usd", amount: 25.5 });
    const mid = ccOwedByCurrencyAtYmd(accountId, "2026-11-03", { strictlyBefore: false })!.owed;
    expect(mid.clp).toBe(100_000);
    expect(mid.usd).toBe(25.5);
    expect(ccOwedByCurrencyAtYmd(accountId, ANNULLED, { strictlyBefore: false })!.owed.usd ?? 0).toBe(0);
    // The peso frame of the evidence nets exactly: both legs at the purchase day's rate.
    const entries = normalizedPostCloseLines(accountId).filter((e) => e.key.startsWith("annulled|"));
    expect(entries).toHaveLength(2);
    expect(entries[0]!.clp! + entries[1]!.clp!).toBe(0);
  });

  it("billing readers never see it: statement-less evidence, no financing cost, no facturado change", () => {
    anchor(100_000);
    insertLines(accountId, {
      lines: [{ transaction_date: "2026-11-01", merchant: "VITEST KEPT SHOP", currency: "clp" as const, amount: 12_000, raw_line: "kept" }],
      errors: [],
    });
    clearAggregationCache();
    const before = JSON.stringify(billingDetailCacheForAccount(accountId).facturaciones);
    insertAnnulled();
    clearAggregationCache();
    expect(JSON.stringify(billingDetailCacheForAccount(accountId).facturaciones)).toBe(before);
    for (const e of normalizedPostCloseLines(accountId).filter((x) => x.key.startsWith("annulled|"))) {
      expect(e.statement_date).toBeNull();
      expect(e.financing).toBeUndefined();
    }
    // The card's P/L is its cost of financing: the purchase and its annulment are flows.
    expect([...ccFinancingCostClpByDate(accountId).values()].reduce((a, b) => a + b, 0)).toBe(0);
    // A month-end window sees the purchase (owed), and the annulment inside the same window cancels it.
    expect(postCloseLiveBalanceAdjustmentClp(accountId, ANCHOR, "2026-11-03")).toBe(80_000 + 12_000);
    expect(postCloseLiveBalanceAdjustmentClp(accountId, ANCHOR, "2026-11-30")).toBe(12_000);
  });

  it("the cupo check's app side counts it only while purchase_date <= asOf < annulled_on", () => {
    insertAnnulled();
    insertAnnulled({ currency: "usd", amount: 10, merchant: "VITEST USD SHOP" });
    const at = (day: string) => ccOwedByCurrency(accountId, day);
    expect(at("2026-11-01").clp.open_cycle_lines).toBe(0);
    expect(at(PURCHASE).clp.open_cycle_lines).toBe(80_000);
    expect(at(PURCHASE).clp.total).toBe(80_000);
    expect(at("2026-11-04").foreign.usd?.open_cycle_lines).toBe(10);
    expect(at(ANNULLED).clp.open_cycle_lines).toBe(0);
    expect(at(ANNULLED).foreign.usd?.total ?? 0).toBe(0);
  });

  describe("expense lines", () => {
    function setupAnnulledWithCategory(): { annulledId: number; key: string } {
      insertLines(accountId, {
        lines: [
          { transaction_date: PURCHASE, merchant: "VITEST VOIDED SHOP", currency: "clp" as const, amount: 80_000, raw_line: "voided" },
          { transaction_date: PURCHASE, merchant: "VITEST KEPT SHOP", currency: "clp" as const, amount: 12_000, raw_line: "kept" },
        ],
        errors: [],
      });
      const lineId = (m: string) =>
        (
          db
            .prepare(
              `SELECT l.id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ? AND l.merchant = ?`
            )
            .get(accountId, m) as { id: number }
        ).id;
      const voided = lineId("VITEST VOIDED SHOP");
      // The user's «Único» category on the bucket line, set before the bank dropped it.
      assignFlowExpenseLineCategory({ lineId: voided, source: "cc", unique: true, categorySlug: "hobbies" });
      const { plan, annulled } = annulOpenBucketLines(accountId, [voided], { annulledOn: ANNULLED, basis: "manual", evidence: null });
      db.prepare(`DELETE FROM cc_statement_lines WHERE id IN (${plan.deleteLineIds.join(",")})`).run();
      clearAggregationCache();
      return { annulledId: annulled[0]!.id, key: annulled[0]!.purchase_key };
    }

    it("the purchase keeps its «Único» category through the deleted line; the annulment refunds it", () => {
      const { annulledId, key } = setupAnnulledWithCategory();
      const lines = buildFlowsExpenseLines([accountId]);
      const purchase = lines.find((l) => l.annulled != null)!;
      const annulment = lines.find((l) => l.annulment != null)!;
      expect(purchase.purchase_key).toBe(key);
      expect(purchase.category_slug).toBe("hobbies");
      expect(purchase.category_unique).toBe(true);
      expect(purchase.occurred_on).toBe(PURCHASE);
      expect(purchase.annulled).toEqual({ annulled_purchase_id: annulledId, annulled_on: ANNULLED, basis: "manual" });
      expect(purchase.statement_line_id).toBe(annulledPurchaseLineId(annulledId, "purchase"));
      expect(purchase.flow_id).toBeGreaterThan(0);
      expect(purchase.counts_toward_gastos).toEqual({ split: true, total: true });
      expect(purchase.annulment).toBeUndefined();

      expect(annulment.purchase_key).toBe(`annulled:${annulledId}`);
      expect(parseExpenseKey(annulment.purchase_key)).toEqual({ kind: "annulment", annulledPurchaseId: annulledId });
      expect(annulment.category_slug).toBe("hobbies");
      expect(annulment.occurred_on).toBe(ANNULLED);
      expect(annulment.card_refund).toBe(true);
      expect(annulment.amount).toEqual({ value: -80_000, currency: "clp" });
      expect(annulment.annulment).toEqual({ annulled_purchase_id: annulledId, purchase_date: PURCHASE });
      expect(annulment.counts_toward_gastos).toEqual({ split: true, total: true });
      expect(annulment.can_delete).toBe(false);
      expect(annulment.can_edit_pieces).toBe(false);

      // Every other line carries neither field.
      const kept = lines.find((l) => l.merchant === "VITEST KEPT SHOP")!;
      expect(kept.annulled).toBeUndefined();
      expect(kept.annulment).toBeUndefined();
    });

    it("gastos net to zero in the purchase's category over both days", () => {
      setupAnnulledWithCategory();
      const lines = buildFlowsExpenseLines([accountId]).filter((l) => l.annulled != null || l.annulment != null);
      expect(lines).toHaveLength(2);
      const agg = aggregateGastosFromLines(lines, ["hobbies"], "total");
      expect(agg.total).toBe(0);
    });

    it("a purchase the bank refunded with a real credit keeps its purchase line and no synthetic refund", () => {
      const { annulledId } = setupAnnulledWithCategory();
      db.prepare(`UPDATE cc_annulled_purchases SET bank_credit = 1 WHERE id = ?`).run(annulledId);
      clearAggregationCache();
      const lines = buildFlowsExpenseLines([accountId]).filter((l) => l.annulled != null || l.annulment != null);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.annulled?.annulled_purchase_id).toBe(annulledId);
      const events = normalizedPostCloseLines(accountId).filter((e) => e.key.startsWith(`annulled|${annulledId}|`));
      expect(events.map((e) => e.key)).toEqual([`annulled|${annulledId}|purchase`]);
    });

    it("the facturación modal lists neither line, any other card line stays", () => {
      setupAnnulledWithCategory();
      const lines = buildFlowsExpenseLines([accountId]);
      const flags = (billing_month: string) => ({ billing_month, is_open_month: true, is_provisional_close: false });
      const annulledMonth = lines.find((l) => l.annulled != null)!.billing_month;
      expect(flowLinesForFacturacionMonth(lines, accountId, flags(annulledMonth)).filter((l) => l.annulled || l.annulment)).toHaveLength(0);
      const kept = lines.find((l) => l.merchant === "VITEST KEPT SHOP")!;
      const listed = flowLinesForFacturacionMonth(lines, accountId, flags(kept.billing_month));
      expect(listed.some((l) => l.merchant === "VITEST KEPT SHOP")).toBe(true);
    });

    it("a category change on either line files under the purchase key; the annulment follows the purchase", () => {
      for (const leg of ["purchase", "annulment"] as const) {
        const { annulledId, key } = setupAnnulledWithCategory();
        const res = assignFlowExpenseLineCategory({
          lineId: annulledPurchaseLineId(annulledId, leg),
          source: "cc",
          unique: true,
          categorySlug: "food",
        });
        expect(res.purchase_key).toBe(key);
        clearAggregationCache();
        const lines = buildFlowsExpenseLines([accountId]).filter((l) => l.annulled != null || l.annulment != null);
        expect(lines.map((l) => l.category_slug)).toEqual(["food", "food"]);
        db.prepare(`DELETE FROM cc_annulled_purchases WHERE id = ?`).run(annulledId);
      }
      expect(() =>
        assignFlowExpenseLineCategory({ lineId: annulledPurchaseLineId(999_999, "purchase"), source: "cc", unique: true, categorySlug: "food" })
      ).toThrow(InputError);
    });

    it("«Últimos movimientos» lists the purchase on its day and the annulment on the day it was dropped", () => {
      const { annulledId } = setupAnnulledWithCategory();
      const lines = buildFlowsExpenseLines([accountId]).filter((l) => l.account_id === accountId);
      const income: FlowsOverviewIncome = {
        lines: [],
        manual: [],
        work_earnings: [],
        income_kind_by_movement_id: {},
        payroll_period_by_movement_id: {},
      };
      const known = new Set(listCcExpenseCategories().map((c) => c.slug));
      const rows = latestMovementRows(lines, income, known, 50, chileCalendarTodayYmd(), new Set());
      const on = (leg: "purchase" | "annulment") =>
        rows.find((r) => r.kind === "expense" && r.line.statement_line_id === annulledPurchaseLineId(annulledId, leg));
      expect(on("purchase")?.on).toBe(PURCHASE);
      expect(on("annulment")?.on).toBe(ANNULLED);
    });
  });
});
