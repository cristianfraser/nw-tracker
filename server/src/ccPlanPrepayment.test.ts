import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { applyListing, listingCard, listingLine } from "./test/cardListingPayloads.js";
import { snapshotTables } from "./test/snapshotTables.js";
import { createManualCcInstallmentPurchase } from "./ccInstallmentManual.js";
import { ccOwedByCurrency } from "./ccOwedByCurrency.js";
import { ccOwedByCurrencyAtYmd } from "./ccOwedWalk.js";
import { installmentPlanBreakdownByMonth, installmentRemainderAfterFacturacionClp } from "./ccInstallmentLedgerDb.js";
import { buildFlowsExpenseLines } from "./flowsExpenses.js";
import { aggregateGastosFromLines } from "./flowsExpensesGastos.js";
import { latestMovementRows } from "./latestMovements.js";
import { assignFlowExpenseLineCategory } from "./expenseAssignmentWrites.js";
import { listCcExpenseCategories } from "./ccExpenseCategories.js";
import { planPrepaymentRows } from "./ccPlanPrepaymentsRead.js";
import { reconcileOpenWebPasteAfterPdfClose } from "./ccOpenWebPastePdfReconcile.js";
import { webPasteLineDedupeKey, type CcListingLine } from "./ccWebPasteParse.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import type { FlowsOverviewIncome } from "./flowsOverview.js";

const restoreDerivedCardState = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_metrics"]);

const LAST4 = "9977";
const BANK_ACCOUNT = "800099990077";
const PRINCIPAL = 71_300;
const FACTURADO = 500_000;
const PURCHASE = "2026-11-05";
const PAID = "2026-11-13";

describe("a plan the bank prepaid", () => {
  let accountId = 0;
  let tmpDir = "";
  let feedSeq = 0;
  const prevIdentifiers = process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS;

  function insertStatement(opts: { source: string; date: string; from?: string; to?: string; currency: "clp" | "usd"; monto?: number | null; nextFrom?: string; nextTo?: string }): number {
    return Number(
      db
        .prepare(
          `INSERT INTO cc_statements (
             account_id, card_group, source_pdf, statement_date, period_from, period_to,
             card_last4, layout, currency, monto_facturado, next_period_from, next_period_to
           ) VALUES (?, 'santander', ?, ?, ?, ?, ?, 'compact', ?, ?, ?, ?)`
        )
        .run(accountId, opts.source, opts.date, opts.from ?? null, opts.to ?? null, LAST4, opts.currency, opts.monto ?? null, opts.nextFrom ?? null, opts.nextTo ?? null)
        .lastInsertRowid
    );
  }

  function webLine(dateIso: string, merchant: string, clp: number): CcListingLine {
    return { transaction_date: dateIso, merchant, currency: "clp", amount: clp, raw_line: merchant };
  }

  function insertLine(statementId: number, dateIso: string, merchant: string, clp: number): number {
    const [y, m, d] = dateIso.split("-");
    const key = webPasteLineDedupeKey("santander", webLine(dateIso, merchant, clp));
    return Number(
      db
        .prepare(
          `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, installment_flag, dedupe_key, parser_row_id, raw_line)
           VALUES (?, ?, ?, ?, 0, ?, ?, 'vitest')`
        )
        .run(statementId, `${Number(d)}/${Number(m)}/${y}`, merchant, clp, key, `web:${key}`).lastInsertRowid
    );
  }

  function addPlan(over: Partial<{ total: number; merchant: string; date: string }> = {}): number {
    return createManualCcInstallmentPurchase(accountId, {
      purchase_date: over.date ?? PURCHASE,
      total_amount_clp: over.total ?? PRINCIPAL,
      cuotas_totales: 6,
      merchant: over.merchant ?? "VITEST MERCADO",
      card_group: "santander",
    }).id;
  }

  const prepagoRow = (amount = PRINCIPAL, merchant = "VITEST MERCADOPAGO NT") => ({
    ...listingLine(PAID, merchant, amount, { raw: "PREPAGO EN CUOTAS" }),
    plan_prepayment: true as const,
  });
  const notaRow = (amount = PRINCIPAL, merchant = "VITEST MERCADOPAGO NT") => ({
    ...listingLine(PURCHASE, merchant, -amount, { raw: "NOTA DE CREDITO" }),
    credit_note: true as const,
  });

  function feed(lines: unknown[]) {
    return applyListing(
      listing(lines),
      `card-movements-vitest-prepay-${++feedSeq}.json`
    ).accounts[0]!;
  }
  function listing(lines: unknown[]) {
    return {
      observed_at: "2026-11-14T01:00:00.000Z",
      cards: [listingCard(BANK_ACCOUNT, lines as ReturnType<typeof listingLine>[], { date: "2026-10-23", clp: FACTURADO, usd: 0 })],
    };
  }

  const owed = (day: string) => ccOwedByCurrencyAtYmd(accountId, day, { strictlyBefore: false })!.owed.clp;
  const lineCount = () =>
    (db.prepare(`SELECT COUNT(*) AS n FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ?`).get(accountId) as { n: number }).n;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-14T15:00:00Z"));
    const group = db.prepare(`SELECT id FROM asset_groups WHERE slug IN ('credit_card', 'credit_cards__credit_card') LIMIT 1`).get() as { id: number };
    const importKey = `credit_card_master|santander|vitest-prepay-${LAST4}`;
    accountId = Number(
      db.prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · prepay', ?, ?)`).run(group.id, importKey, importKey).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4, issuer) VALUES (?, 21, 20, ?, 'santander')`
    ).run(accountId, LAST4);
    insertStatement({ source: "vitest 2026-10-23 clp.pdf", date: "23/10/2026", from: "24/09/2026", to: "23/10/2026", currency: "clp", monto: FACTURADO, nextFrom: "23/10/2026", nextTo: "23/11/2026" });
    insertStatement({ source: "vitest 2026-10-23 usd.pdf", date: "23/10/2026", from: "24/09/2026", to: "23/10/2026", currency: "usd", monto: 0 });
    db.prepare(`INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, '2026-10-30', ?, 'clp')`).run(accountId, FACTURADO);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-prepay-"));
    const identifiers = path.join(tmpDir, "organize-identifiers.json");
    fs.writeFileSync(identifiers, JSON.stringify({ santander_80_account_to_card_last4: { [BANK_ACCOUNT]: LAST4 } }));
    process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS = identifiers;
    clearAggregationCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.prepare(`DELETE FROM cc_plan_prepayments WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM cc_bank_cupo_captures WHERE source_file LIKE 'card-movements-vitest-prepay-%'`).run();
    db.prepare(`DELETE FROM cc_feed_billing_closes WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM cc_billing_month_metrics WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM flow_categories WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM cc_installment_purchases WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM import_batches WHERE raw_text LIKE ?`).run(`%"account_id":${accountId},%`);
    db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevIdentifiers == null) delete process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS;
    else process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS = prevIdentifiers;
    restoreDerivedCardState();
  });

  it("pairs the prepayment and the refund with the plan, and a repeat of the listing changes nothing", () => {
    const planId = addPlan();
    const first = feed([notaRow(), prepagoRow()]);
    expect(first.plan_prepayments).toHaveLength(1);
    const [row] = planPrepaymentRows(accountId);
    expect(row).toMatchObject({ purchase_id: planId, paid_on: PAID, amount_clp: PRINCIPAL });
    expect(row!.line_id).not.toBeNull();
    expect(row!.credit_line_id).not.toBeNull();
    expect(row!.line_id).not.toBe(row!.credit_line_id);
    const lines = lineCount();

    const second = feed([notaRow(), prepagoRow()]);
    expect(second.inserted).toBe(0);
    expect(lineCount()).toBe(lines);
    expect(planPrepaymentRows(accountId)).toEqual([row]);
    expect(second.plan_prepayments).toHaveLength(1);
  });

  it("the card owes what the bank's cupo identity gives: the plan leaves the remainder, the prepayment and the refund net to zero", () => {
    addPlan();
    expect(installmentRemainderAfterFacturacionClp(accountId, "2026-10", "2026-11-14").amount_clp).toBe(PRINCIPAL);
    feed([notaRow(), prepagoRow()]);
    clearAggregationCache();

    const cupo = ccOwedByCurrency(accountId, "2026-11-14").clp;
    expect(cupo.facturado).toBe(FACTURADO);
    expect(cupo.installment_remainder).toBe(0);
    expect(cupo.open_cycle_lines).toBe(0);
    expect(cupo.total).toBe(FACTURADO);

    // The walk never leaves the anchor: the plan and the refund net on the purchase day, the plan's
    // payoff and the prepayment on the payoff day.
    for (const day of ["2026-11-01", "2026-11-04", PURCHASE, "2026-11-10", "2026-11-12", PAID, "2026-11-14"]) {
      expect(owed(day)).toBe(FACTURADO);
    }
    // The cuota calendar no longer lists the plan.
    expect([...installmentPlanBreakdownByMonth(accountId).values()].flat()).toEqual([]);
  });

  describe("expense lines", () => {
    function setup(): void {
      const planId = addPlan();
      feed([notaRow(), prepagoRow()]);
      // The plan's own category, as the user sets it on the purchase («Ocio» in the real case).
      assignFlowExpenseLineCategory({ lineId: -planId, source: "cc", unique: true, categorySlug: "hobbies" });
      clearAggregationCache();
    }

    it("the purchase and its refund net to zero in the plan's category; the prepayment is no spending", () => {
      setup();
      const lines = buildFlowsExpenseLines([accountId]).filter((l) => l.account_id === accountId);
      const total = lines.find((l) => l.line_role === "installment_purchase_total")!;
      const nota = lines.find((l) => l.amount!.value < 0)!;
      expect(total.category_slug).toBe("hobbies");
      expect(total.counts_toward_gastos!.total).toBe(true);
      expect(nota.card_refund).toBe(true);
      expect(nota.category_slug).toBe("hobbies");
      expect(nota.amount!.value).toBe(-PRINCIPAL);
      expect(nota.counts_toward_gastos).toEqual({ split: false, total: true });
      // Nothing else positive: the prepayment line is not an expense.
      expect(lines.filter((l) => l.amount!.value > 0).map((l) => l.line_role)).toEqual(["installment_purchase_total"]);
      expect(lines).toHaveLength(2);
      for (const mode of ["total", "split"] as const) {
        expect(aggregateGastosFromLines(lines, ["hobbies"], mode).total).toBe(0);
      }
    });

    it("«Últimos movimientos» shows the purchase and its refund, no prepayment row", () => {
      setup();
      const lines = buildFlowsExpenseLines([accountId]).filter((l) => l.account_id === accountId);
      const income: FlowsOverviewIncome = { lines: [], manual: [], work_earnings: [], income_kind_by_movement_id: {}, payroll_period_by_movement_id: {} };
      const known = new Set(listCcExpenseCategories().map((c) => c.slug));
      const rows = latestMovementRows(lines, income, known, 50, chileCalendarTodayYmd(), new Set());
      const amounts = rows.filter((r) => r.kind === "expense").map((r) => (r.kind === "expense" ? r.line.amount.value : 0)).sort((a, b) => a - b);
      expect(amounts).toEqual([-PRINCIPAL, PRINCIPAL]);
    });
  });

  describe("refusals (nothing written)", () => {
    const untouched = () => {
      expect(planPrepaymentRows(accountId)).toEqual([]);
      expect(lineCount()).toBe(0);
    };

    it("no plan of the card is paid off by the prepayment", () => {
      expect(() => feed([notaRow(), prepagoRow()])).toThrow(/matches 0 plans/);
      untouched();
    });

    it("two plans fit equally", () => {
      addPlan();
      addPlan({ date: "2026-11-06" });
      expect(() => feed([notaRow(), prepagoRow()])).toThrow(/matches 2 plans/);
      untouched();
    });

    it("the amount differs from the plan's principal", () => {
      addPlan();
      expect(() => feed([prepagoRow(PRINCIPAL - 1_000)])).toThrow(/matches 0 plans/);
      untouched();
    });

    it("a plan with a cuota already billed is not a candidate", () => {
      const planId = addPlan();
      db.prepare(
        `INSERT INTO cc_installment_payments (purchase_id, pay_by_date, statement_date, amount_clp, cuota_current, cuota_total, source_pdf)
         VALUES (?, '2026-11-10', '23/10/2026', 11880, 1, 6, 'vitest 2026-10-23 clp.pdf')`
      ).run(planId);
      expect(() => feed([prepagoRow()])).toThrow(/matches 0 plans/);
      untouched();
    });
  });

  describe("the statement that closes the cycle", () => {
    const NOV = "import:web-paste|open|2026-11";

    function statement(): number {
      return insertStatement({ source: "vitest 2026-11-23 clp.pdf", date: "23/11/2026", from: "23/10/2026", to: "23/11/2026", currency: "clp", monto: FACTURADO, nextFrom: "23/11/2026", nextTo: "23/12/2026" });
    }

    it("keeps the prepayment and its refund when the statement does not print them", () => {
      addPlan();
      feed([notaRow(), prepagoRow()]);
      const [row] = planPrepaymentRows(accountId);
      const st = statement();
      insertLine(st, "2026-11-08", "VITEST OTRA TIENDA", 9_000);
      const result = reconcileOpenWebPasteAfterPdfClose(accountId, "2026-11");
      expect(result.kept_plan_prepayment_line_ids.sort()).toEqual([row!.line_id!, row!.credit_line_id!].sort());
      expect(result.annulled_line_ids).toEqual([]);
      expect(result.deleted_line_ids).not.toContain(row!.line_id);
      expect(result.deleted_line_ids).not.toContain(row!.credit_line_id);
      expect(planPrepaymentRows(accountId)).toEqual([row]);
      expect(db.prepare(`SELECT 1 FROM cc_statement_lines WHERE id = ?`).get(row!.line_id)).toBeDefined();
    });

    it("hands both lines to the statement lines that bill them", () => {
      addPlan();
      feed([notaRow(), prepagoRow()]);
      const [row] = planPrepaymentRows(accountId);
      const st = statement();
      const printedPrepago = insertLine(st, PAID, "VITEST MERCADOPAGO NT", PRINCIPAL);
      const printedNota = insertLine(st, PURCHASE, "VITEST MERCADOPAGO NT", -PRINCIPAL);
      const result = reconcileOpenWebPasteAfterPdfClose(accountId, "2026-11");
      expect(result.deleted_line_ids.sort()).toEqual([row!.line_id!, row!.credit_line_id!].sort());
      const [after] = planPrepaymentRows(accountId);
      expect(after).toMatchObject({ line_id: printedPrepago, credit_line_id: printedNota, purchase_id: row!.purchase_id });
      expect(NOV).toMatch(/2026-11/);
    });
  });
});
