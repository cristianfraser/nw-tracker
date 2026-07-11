import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  applyWebPasteInstallmentFirstDueNudges,
} from "./ccWebPasteInstallmentNudge.js";
import type { CcWebPasteLine } from "./ccWebPasteParse.js";
import {
  ccInstallmentsDbApiPayload,
  purchaseFirstDueYm,
} from "./ccInstallmentLedgerDb.js";
import { createManualCcInstallmentPurchase } from "./ccInstallmentManual.js";
import {
  ensureVitestCreditCardFixtures,
  getVitestSantanderCcMasterAccountId,
} from "./test/vitestDbSeed.js";
import { billingMonthForManualLedgerPurchase } from "./ccManualBillingMonth.js";
import {
  billingMonthForPurchaseDate,
  billingPeriodIsoRange,
  loadCreditCardBillingConfig,
} from "./ccBillingMonth.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import { snapshotTables } from "./test/snapshotTables.js";

// Manual-purchase creation + the nudge upsert valuations; restore exact rows afterwards.
const restoreValuations = snapshotTables(["valuations"]);
afterAll(() => restoreValuations());

const createdPurchaseIds: number[] = [];

function trackPurchase(id: number): number {
  createdPurchaseIds.push(id);
  return id;
}

afterEach(() => {
  for (const id of createdPurchaseIds.splice(0)) {
    db.prepare(`DELETE FROM cc_installment_purchases WHERE id = ?`).run(id);
  }
});

function webPasteLine(
  transactionDateIso: string,
  merchant: string,
  amountClp: number
): CcWebPasteLine {
  return {
    transaction_date: transactionDateIso,
    merchant,
    amount_clp: amountClp,
    amount_usd: null,
    currency: "clp",
    raw_line: `${transactionDateIso}\t${merchant}\t${amountClp}`,
  };
}

/** A purchase date guaranteed to fall in the open billing cycle, or null if config is unexpected. */
function purchaseDateInOpenCycle(accountId: number, openBm: string): string | null {
  const config = loadCreditCardBillingConfig(accountId);
  const range = billingPeriodIsoRange(openBm, config);
  if (!range) return null;
  if (billingMonthForPurchaseDate(range.period_to, config) !== openBm) return null;
  return range.period_to;
}

function computedFirstDueMonth(accountId: number, purchaseId: number): string | null {
  const payload = ccInstallmentsDbApiPayload(accountId);
  const row = payload.purchases.find((p) => p.purchase_db_id === purchaseId);
  return row?.first_due_month ?? null;
}

describe("applyWebPasteInstallmentFirstDueNudges", () => {
  it("pins a manual plan's first_due_month to the open cycle from a pasted cuota line", () => {
    ensureVitestCreditCardFixtures();
    const accountId = getVitestSantanderCcMasterAccountId();
    if (accountId == null) return;
    const openBm = billingMonthForManualLedgerPurchase(accountId);
    if (!openBm) return;
    const purchaseDate = purchaseDateInOpenCycle(accountId, openBm);
    if (!purchaseDate) return;

    // Manual plan with LIDER-style merchant so the pasted (longer) merchant matches by prefix.
    const { id } = createManualCcInstallmentPurchase(accountId, {
      purchase_date: purchaseDate,
      total_amount_clp: 90_000,
      cuotas_totales: 6,
      merchant: "VITEST NUDGE LIDER DOMICILIO VENTAS",
    });
    trackPurchase(id);

    // Before the nudge, the manual heuristic guesses first cuota bills the NEXT cycle.
    expect(computedFirstDueMonth(accountId, id)).toBe(addCalendarMonths(openBm, 1));

    // Paste re-lists the plan's per-cuota charge (90.000 / 6 = 15.000) with the full merchant name.
    const lines = [
      webPasteLine(purchaseDate, "VITEST NUDGE LIDER DOMICILIO VENTAS Y DISTRIBUCION LTDA", 15_000),
    ];
    const nudges = applyWebPasteInstallmentFirstDueNudges(accountId, lines);

    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toMatchObject({ purchase_id: id, from: null, to: openBm });
    // Stored + recomputed: the plan now bills cuota 01 in the open cycle, not open+1.
    const stored = db
      .prepare(`SELECT first_due_month FROM cc_installment_purchases WHERE id = ?`)
      .get(id) as { first_due_month: string | null };
    expect(stored.first_due_month).toBe(openBm);
    expect(computedFirstDueMonth(accountId, id)).toBe(openBm);

    // Idempotent: a re-paste of the same block writes nothing (first_due_month no longer NULL).
    expect(applyWebPasteInstallmentFirstDueNudges(accountId, lines)).toHaveLength(0);
  });

  it("does not fire when the plan already has a billed cuota payment", () => {
    ensureVitestCreditCardFixtures();
    const accountId = getVitestSantanderCcMasterAccountId();
    if (accountId == null) return;
    const openBm = billingMonthForManualLedgerPurchase(accountId);
    if (!openBm) return;
    const purchaseDate = purchaseDateInOpenCycle(accountId, openBm);
    if (!purchaseDate) return;

    const { id } = createManualCcInstallmentPurchase(accountId, {
      purchase_date: purchaseDate,
      total_amount_clp: 60_000,
      cuotas_totales: 6,
      merchant: "VITEST NUDGE PAID",
    });
    trackPurchase(id);
    db.prepare(
      `INSERT INTO cc_installment_payments (purchase_id, pay_by_date, amount_clp, cuota_current, cuota_total, parser_row_id)
       VALUES (?, ?, ?, 1, 6, ?)`
    ).run(id, `${openBm}-05`, 10_000, `vitest-nudge-pay-${Date.now()}`);

    const nudges = applyWebPasteInstallmentFirstDueNudges(accountId, [
      webPasteLine(purchaseDate, "VITEST NUDGE PAID", 10_000),
    ]);
    expect(nudges).toHaveLength(0);
    const stored = db
      .prepare(`SELECT first_due_month FROM cc_installment_purchases WHERE id = ?`)
      .get(id) as { first_due_month: string | null };
    expect(stored.first_due_month).toBeNull();
  });

  it("does not fire for a pdf-sourced plan", () => {
    ensureVitestCreditCardFixtures();
    const accountId = getVitestSantanderCcMasterAccountId();
    if (accountId == null) return;
    const openBm = billingMonthForManualLedgerPurchase(accountId);
    if (!openBm) return;
    const purchaseDate = purchaseDateInOpenCycle(accountId, openBm);
    if (!purchaseDate) return;

    const canonical = `vitest-nudge-pdf-${Date.now()}`;
    const r = db
      .prepare(
        `INSERT INTO cc_installment_purchases (
           account_id, card_group, canonical_row_id, purchase_date, total_amount_clp,
           cuotas_totales, merchant, source
         ) VALUES (?, 'A', ?, ?, ?, ?, ?, 'pdf')`
      )
      .run(accountId, canonical, purchaseDate, 90_000, 6, "VITEST NUDGE PDF");
    const id = trackPurchase(Number(r.lastInsertRowid));

    const nudges = applyWebPasteInstallmentFirstDueNudges(accountId, [
      webPasteLine(purchaseDate, "VITEST NUDGE PDF", 15_000),
    ]);
    expect(nudges).toHaveLength(0);
    const stored = db
      .prepare(`SELECT first_due_month FROM cc_installment_purchases WHERE id = ?`)
      .get(id) as { first_due_month: string | null };
    expect(stored.first_due_month).toBeNull();
  });

  it("does not fire when the purchase's own cycle is not the open month", () => {
    ensureVitestCreditCardFixtures();
    const accountId = getVitestSantanderCcMasterAccountId();
    if (accountId == null) return;
    const openBm = billingMonthForManualLedgerPurchase(accountId);
    if (!openBm) return;
    const config = loadCreditCardBillingConfig(accountId);
    // A purchase three cycles before the open month resolves to a different billing month.
    const olderBm = addCalendarMonths(openBm, -3);
    const olderRange = billingPeriodIsoRange(olderBm, config);
    if (!olderRange || billingMonthForPurchaseDate(olderRange.period_to, config) !== olderBm) return;

    const { id } = createManualCcInstallmentPurchase(accountId, {
      purchase_date: olderRange.period_to,
      total_amount_clp: 90_000,
      cuotas_totales: 6,
      merchant: "VITEST NUDGE OLD CYCLE",
    });
    trackPurchase(id);

    const nudges = applyWebPasteInstallmentFirstDueNudges(accountId, [
      webPasteLine(olderRange.period_to, "VITEST NUDGE OLD CYCLE", 15_000),
    ]);
    expect(nudges).toHaveLength(0);
  });
});

describe("purchaseFirstDueYm precedence", () => {
  const basePurchase = {
    id: 1,
    canonical_row_id: "x",
    card_group: "A",
    purchase_date: "2026-06-05",
    total_amount_clp: 90_000,
    cuotas_totales: 6,
    merchant: "TGR",
    description_merged: null,
    matched_baseline_purchase_id: null,
    source: "manual",
    first_due_month: "2026-09",
  };

  it("stored first_due_month outranks the manual open+1 guess", () => {
    // No payList and no accountId → the manual branch is skipped; the stored value wins.
    expect(purchaseFirstDueYm({ ...basePurchase }, [])).toBe("2026-09");
  });

  it("a statement cuota-01 line still outranks the stored first_due_month", () => {
    const payList = [
      {
        id: 1,
        purchase_id: 1,
        pay_by_date: "2026-07-25",
        statement_date: null,
        statement_period_month: "2026-07",
        period_to_join: null,
        source_pdf: "jul.pdf",
        amount_clp: 15_000,
        cuota_current: 1,
        cuota_total: 6,
      },
    ];
    expect(purchaseFirstDueYm({ ...basePurchase }, payList)).toBe("2026-07");
  });
});
