import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  billingDetailBalanceClp,
  buildBillingDetailByMonth,
  buildFacturaciones,
  facturadoClpFromOpenMonthStatementLines,
  paymentAbonosClpForBillingMonth,
} from "./ccBillingViews.js";
import { cardStoppedBilling } from "./cards/lifecycle.js";
import {
  ccInstallmentsDbApiPayload,
  installmentRemainingClpByCalendarMonth,
  ledgerFacturadoClpForBillingMonth,
} from "./ccInstallmentLedgerDb.js";
import { latestCreditCardBillingBalanceTotalClp } from "./ccCreditCardValuations.js";
import { accountTodayValue } from "./accountTodayValue.js";
import {
  ensureVitestCreditCardFixtures,
  getVitestSantanderCcMasterAccountId,
  wipeVitestCcFixtureData,
} from "./test/vitestDbSeed.js";
import { createManualCcInstallmentPurchase } from "./ccInstallmentManual.js";
import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import { billingMonthForManualLedgerPurchase, lastPdfBillingMonthForAccount } from "./cards/facturacion.js";
import { ymCompare } from "./calendarMonth.js";
import { listCcStatementsForAccount } from "./ccStatementsDb.js";
import * as chileDate from "./chileDate.js";
import { snapshotTables } from "./test/snapshotTables.js";
import { addCalendarMonths } from "nw-tracker-contracts";
import { facturadoForeignIn } from "./ccBillingViews.js";

// The manual-purchase cases run createManualCcInstallmentPurchase on the real 4242 CC master,
// which upserts valuations (a today-dated row + restated month-ends) via
// upsertCreditCardValuationsFromLedger. Deleting the purchase + recomputing balances doesn't
// undo those valuation writes, so snapshot valuations and restore exact rows in afterAll.
const restoreValuations = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_metrics"]);
afterAll(() => restoreValuations());

describe("billingDetailBalanceClp", () => {
  it("balance = facturado + post-close plan remainder (billed cuota rides inside facturado only)", () => {
    // The pre-2026-08 form subtracted cuota_a_pagar_next_mes again, sinking every closed
    // month-end anchor one billed cuota below true owed (see the function doc).
    expect(billingDetailBalanceClp(5_561_828, 5_000_000)).toBe(10_561_828);
  });

  it("projected plan month with no facturado: saldo equals cupo", () => {
    expect(billingDetailBalanceClp(null, 4_200_000)).toBe(4_200_000);
  });
});

describe("projected future billing months", () => {
  it("months after the open facturación carry no facturado and saldo = owed at month-end (pay frame)", () => {
    ensureVitestCreditCardFixtures();
    const accountId = getVitestSantanderCcMasterAccountId();
    if (!accountId) return;

    createManualCcInstallmentPurchase(accountId, {
      purchase_date: chileDate.chileCalendarTodayYmd(),
      total_amount_clp: 600_000,
      cuotas_totales: 6,
      merchant: "Vitest projected billing months",
    });
    try {
      recomputeCcBillingMonthBalances(accountId);
      const payload = ccInstallmentsDbApiPayload(accountId);
      const allScheduleMonths = payload.installment_history_months.map((h) => ({
        month: h.month,
        total_clp: h.installment_payments_clp,
        breakdown: [],
      }));
      const det = buildBillingDetailByMonth(accountId, allScheduleMonths);
      const openBm = billingMonthForManualLedgerPurchase(accountId);
      expect(openBm).toBeTruthy();
      const openRow = det.find((d) => d.billing_month === openBm);
      expect(openRow).toBeDefined();
      expect(openRow!.projected).toBeUndefined();

      // Plan extends past the open month → projected rows exist. None of them mirrors the
      // open row: facturado is null (nothing billed yet) and saldo is pay-frame owed at that
      // month-end — the remainder after the PREVIOUS month's close (a cycle's cuotas leave
      // the debt on their pay-by, ~10th of the next month, not at the close billing them).
      const projectedRows = det.filter((d) => ymCompare(d.billing_month, openBm!) > 0);
      expect(projectedRows.length).toBeGreaterThan(0);
      const remainingByMonth = installmentRemainingClpByCalendarMonth(accountId);
      for (const row of projectedRows) {
        expect(row.projected).toBe(true);
        expect(row.total_facturado_clp).toBeNull();
        expect(row.balance_statement_clp).toBe(
          remainingByMonth.get(addCalendarMonths(row.billing_month, -1)) ?? 0
        );
      }

      // Live «Balance total» must read the open row, never a projected month.
      expect(latestCreditCardBillingBalanceTotalClp(accountId)).toBe(
        Math.round(openRow!.balance_statement_clp)
      );
    } finally {
      wipeVitestCcFixtureData();
      recomputeCcBillingMonthBalances(accountId);
    }
  });
});

describe("buildBillingDetailByMonth", () => {
  it("open month rolls prior closed balance into balance_total (facturado stays cycle-scoped)", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE import_key = 'credit_card_master|santander|4321'`)
      .get() as { id: number } | undefined;
    if (!master) throw new Error("the Vitest person's card lacks the state this test reads");

    recomputeCcBillingMonthBalances(master.id);
    const payload = ccInstallmentsDbApiPayload(master.id);
    const lastPdf = lastPdfBillingMonthForAccount(master.id);
    const openBm = billingMonthForManualLedgerPurchase(master.id);
    if (!lastPdf || !openBm) throw new Error("the Vitest person's card lacks the state this test reads");
    if (ymCompare(openBm, addCalendarMonths(lastPdf, 1)) < 0) throw new Error("the Vitest person's card lacks the state this test reads");

    const det = buildBillingDetailByMonth(master.id, payload.months);
    const may = det.find((d) => d.billing_month === lastPdf);
    const openRow = det.find((d) => d.billing_month === openBm);
    if (!may?.total_facturado_clp || !openRow) throw new Error("the Vitest person's card lacks the state this test reads");

    expect(openRow.as_of_kind).toBe("manual");
    expect(openRow.total_facturado_clp).toBeGreaterThan(0);
    // Open month: the live debt, the card's owed today (the Pasivos today point reads this row).
    expect(openRow.balance_statement_clp).toBe(accountTodayValue(master.id)!.value_clp);
  });

  it("open month facturado is this cycle's charges plus cuota a pagar (not rolled)", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE import_key = 'credit_card_master|santander|4321'`)
      .get() as { id: number } | undefined;
    if (!master) throw new Error("the Vitest person's card lacks the state this test reads");

    const openBm = billingMonthForManualLedgerPurchase(master.id);
    const lastPdf = lastPdfBillingMonthForAccount(master.id);
    if (!openBm || !lastPdf || ymCompare(openBm, lastPdf) <= 0) throw new Error("the Vitest person's card lacks the state this test reads");

    recomputeCcBillingMonthBalances(master.id);
    const payload = ccInstallmentsDbApiPayload(master.id);
    const det = buildBillingDetailByMonth(master.id, payload.months);
    const openRow = det.find((d) => d.billing_month === openBm);
    const may = det.find((d) => d.billing_month === lastPdf);
    if (!openRow || !may?.total_facturado_clp) throw new Error("the Vitest person's card lacks the state this test reads");

    // Facturado for the open cycle = únicos billed this cycle + cuota a pagar; the prior
    // closed month's facturado is NOT rolled in (that lives in deuda/saldo).
    const uniquo = facturadoClpFromOpenMonthStatementLines(master.id, openBm);
    const expected = uniquo + openRow.cuota_a_pagar_next_mes_clp;

    expect(openRow.total_facturado_clp).toBe(expected);
    // Open month did not roll the prior closed facturado into this cycle.
    expect(openRow.total_facturado_clp ?? 0).toBeLessThan(may.total_facturado_clp ?? 0);
    // …but the balance carries the prior closed month's debt forward: it is the card's owed today.
    expect(openRow.balance_statement_clp).toBe(accountTodayValue(master.id)!.value_clp);
  });

  it("open month includes charges when PAGO and purchases share web-paste bucket", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE import_key = 'credit_card_master|santander|4321'`)
      .get() as { id: number } | undefined;
    if (!master) throw new Error("the Vitest person's card lacks the state this test reads");

    const openBm = billingMonthForManualLedgerPurchase(master.id);
    const lastPdf = lastPdfBillingMonthForAccount(master.id);
    if (!openBm || !lastPdf || ymCompare(openBm, lastPdf) <= 0) throw new Error("the Vitest person's card lacks the state this test reads");

    const stmt = listCcStatementsForAccount(master.id).find((s) => s.billing_month === openBm);
    if (!stmt) throw new Error("the Vitest person's card lacks the state this test reads");

    recomputeCcBillingMonthBalances(master.id);
    const payload = ccInstallmentsDbApiPayload(master.id);
    const before = buildBillingDetailByMonth(master.id, payload.months).find(
      (d) => d.billing_month === openBm
    );
    if (!before) throw new Error("the Vitest person's card lacks the state this test reads");

    const chargeA = 100_000;
    const chargeB = 50_000;
    const pagoClp = 1_000_000;
    const dedupeBase = `vitest-pago-charges-${Date.now()}`;
    const insA = db
      .prepare(
        `INSERT INTO cc_statement_lines (
           statement_id, transaction_date, merchant, amount, installment_flag, dedupe_key
         ) VALUES (?, ?, 'VITEST SHOP A', ?, 0, ?)`
      )
      .run(stmt.id, `${openBm}-10`, chargeA, `${dedupeBase}-a`);
    const insB = db
      .prepare(
        `INSERT INTO cc_statement_lines (
           statement_id, transaction_date, merchant, amount, installment_flag, dedupe_key
         ) VALUES (?, ?, 'VITEST SHOP B', ?, 0, ?)`
      )
      .run(stmt.id, `${openBm}-11`, chargeB, `${dedupeBase}-b`);
    const insPago = db
      .prepare(
        `INSERT INTO cc_statement_lines (
           statement_id, transaction_date, merchant, amount, installment_flag, dedupe_key
         ) VALUES (?, ?, 'PAGO', ?, 0, ?)`
      )
      .run(stmt.id, `${openBm}-12`, -pagoClp, `${dedupeBase}-pago`);

    try {
      const after = buildBillingDetailByMonth(master.id, payload.months).find(
        (d) => d.billing_month === openBm
      );
      expect(after).toBeDefined();
      // Open-month facturado tracks únicos billed this cycle (charges) plus cuota a pagar. The
      // PAGO settles the PRIOR facturación and is NOT netted here — it flows through the balance
      // roll-forward only. So facturado rises by exactly the two charges even though the PAGO
      // (1,000,000) dwarfs them; the old netting formula would have clamped facturado to 0.
      const uniquo = facturadoClpFromOpenMonthStatementLines(master.id, openBm);
      expect(after!.total_facturado_clp).toBe(uniquo + after!.cuota_a_pagar_next_mes_clp);
      expect(after!.total_facturado_clp! - (before.total_facturado_clp ?? 0)).toBe(
        chargeA + chargeB
      );
      expect(uniquo).toBeGreaterThanOrEqual(chargeA + chargeB);
      // Facturaciones view shares the helper, so it must report the same un-clamped facturado.
      const factAfter = buildFacturaciones(master.id, payload.months).find(
        (f) => f.billing_month === openBm
      );
      expect(factAfter?.facturado_total_clp).toBe(after!.total_facturado_clp);
      // Balance, in contrast, DOES net the PAGO: it moves by the charges less the payment.
      expect(after!.balance_statement_clp - before.balance_statement_clp).toBe(chargeA + chargeB - pagoClp);
    } finally {
      for (const id of [insA.lastInsertRowid, insB.lastInsertRowid, insPago.lastInsertRowid]) {
        db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`).run(id);
      }
    }
  });

  it("PAGO in open month reduces balance_total but leaves facturado unchanged", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE import_key = 'credit_card_master|santander|4321'`)
      .get() as { id: number } | undefined;
    if (!master) throw new Error("the Vitest person's card lacks the state this test reads");

    const openBm = billingMonthForManualLedgerPurchase(master.id);
    const lastPdf = lastPdfBillingMonthForAccount(master.id);
    if (!openBm || !lastPdf || ymCompare(openBm, lastPdf) <= 0) throw new Error("the Vitest person's card lacks the state this test reads");

    const stmt = listCcStatementsForAccount(master.id).find((s) => s.billing_month === openBm);
    if (!stmt) throw new Error("the Vitest person's card lacks the state this test reads");

    recomputeCcBillingMonthBalances(master.id);
    const payload = ccInstallmentsDbApiPayload(master.id);
    const before = buildBillingDetailByMonth(master.id, payload.months).find(
      (d) => d.billing_month === openBm
    );
    if (!before) throw new Error("the Vitest person's card lacks the state this test reads");

    const pagoClp = 50_000;
    const ins = db
      .prepare(
        `INSERT INTO cc_statement_lines (
           statement_id, transaction_date, merchant, amount, installment_flag, dedupe_key
         ) VALUES (?, ?, 'PAGO', ?, 0, ?)`
      )
      .run(stmt.id, `${openBm}-05`, -pagoClp, `vitest-pago-${Date.now()}`);

    try {
      expect(paymentAbonosClpForBillingMonth(master.id, openBm)).toBeGreaterThanOrEqual(pagoClp);
      const after = buildBillingDetailByMonth(master.id, payload.months).find(
        (d) => d.billing_month === openBm
      );
      expect(after).toBeDefined();
      // Facturado tracks this cycle's charges + cuota; a PAGO settles the PRIOR bill and is not
      // netted, so inserting a PAGO alone (no new charges) leaves facturado exactly unchanged.
      const uniquo = facturadoClpFromOpenMonthStatementLines(master.id, openBm);
      expect(after!.total_facturado_clp).toBe(uniquo + after!.cuota_a_pagar_next_mes_clp);
      expect(after!.total_facturado_clp).toBe(before.total_facturado_clp);
      // The PAGO reduces the rolled balance by exactly its amount.
      expect(after!.balance_statement_clp - before.balance_statement_clp).toBe(-pagoClp);
    } finally {
      db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`).run(ins.lastInsertRowid);
    }
  });

  it("inactive card omits synthetic open months without imported statements", () => {
    // Synthetic dormant card: closed statements months ago, no installment ledger, $0 live.
    // (A real use case, not a reference to a live card whose state drifts over time.)
    const bucket = db
      .prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%credit_card%' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!bucket) throw new Error("the Vitest person's card lacks the state this test reads");

    const importKey = `credit_card_master|santander|vitest-inactive-${Date.now()}`;
    const acctId = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, import_key)
           VALUES (?, 'Vitest · inactive fixture', ?, ?)`
        )
        .run(bucket.id, importKey, importKey).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4, issuer)
       VALUES (?, 21, 20, '0000', 'santander')`
    ).run(acctId);
    const insStmt = db.prepare(
      `INSERT INTO cc_statements
         (account_id, card_group, source_pdf, statement_date, period_from, period_to, card_last4, layout, currency)
       VALUES (?, 'test', ?, ?, ?, ?, '0000', 'compact', 'clp')`
    );
    // Both billing months are well before the current month (period_to month wins).
    insStmt.run(acctId, "2025-01-21 estado de cuenta.pdf", "21/01/2025", "21/12/2024", "20/01/2025");
    insStmt.run(acctId, "2025-02-21 estado de cuenta.pdf", "21/02/2025", "21/01/2025", "20/02/2025");

    try {
      expect(cardStoppedBilling(acctId)).toBe(true);

      recomputeCcBillingMonthBalances(acctId);
      const payload = ccInstallmentsDbApiPayload(acctId);
      const det = buildBillingDetailByMonth(acctId, payload.months);
      expect(det.length).toBeGreaterThan(0);
      expect(det.every((row) => row.as_of_kind === "statement")).toBe(true);

      const todayMonth = new Date().toISOString().slice(0, 7);
      expect(det.some((row) => row.billing_month >= todayMonth)).toBe(false);
      expect(det[0]!.billing_month < todayMonth).toBe(true);
    } finally {
      db.prepare(`DELETE FROM cc_billing_month_metrics WHERE account_id = ?`).run(acctId);
      db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(acctId);
      db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(acctId);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(acctId);
    }
  });
});

describe("buildFacturaciones", () => {
  it("derives facturado from statement lines when header monto is empty (web paste)", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE import_key = 'credit_card_master|santander|4321'`)
      .get() as { id: number } | undefined;
    if (!master) throw new Error("the Vitest person's card lacks the state this test reads");

    recomputeCcBillingMonthBalances(master.id);
    const payload = ccInstallmentsDbApiPayload(master.id);
    const fact = buildFacturaciones(master.id, payload.months);
    const withFacturado = fact.filter((f) => (f.facturado_total_clp ?? 0) > 0);
    if (withFacturado.length === 0) throw new Error("the Vitest person's card lacks the state this test reads");
    const row = withFacturado[0]!;
    const det = buildBillingDetailByMonth(master.id, payload.months).find(
      (d) => d.billing_month === row.billing_month
    );
    expect(row.facturado_total_clp).toBeGreaterThan(0);
    expect(row.close_date_iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(det).toBeDefined();
    expect(det!.total_facturado_clp).toBe(row.facturado_total_clp);
  });

  it("open month facturado_total equals uniquo statement lines plus cuota a pagar", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE import_key = 'credit_card_master|santander|4321'`)
      .get() as { id: number } | undefined;
    if (!master) throw new Error("the Vitest person's card lacks the state this test reads");

    const openBm = billingMonthForManualLedgerPurchase(master.id);
    if (!openBm) throw new Error("the Vitest person's card lacks the state this test reads");

    const payload = ccInstallmentsDbApiPayload(master.id);
    const openRow = buildFacturaciones(master.id, payload.months).find(
      (f) => f.billing_month === openBm
    );
    if (!openRow?.is_open_month) throw new Error("the Vitest person's card lacks the state this test reads");

    const uniquo = facturadoClpFromOpenMonthStatementLines(master.id, openBm);
    const cuota = openRow.cuota_a_pagar_clp ?? 0;
    expect(openRow.facturado_total_clp).toBe(uniquo + cuota);
    expect(openRow.is_open_month).toBe(true);
  });

  it("open month facturado_total equals facturado_clp plus facturado_usd_clp", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE import_key = 'credit_card_master|santander|4321'`)
      .get() as { id: number } | undefined;
    if (!master) throw new Error("the Vitest person's card lacks the state this test reads");

    const openBm = billingMonthForManualLedgerPurchase(master.id);
    if (!openBm) throw new Error("the Vitest person's card lacks the state this test reads");

    const payload = ccInstallmentsDbApiPayload(master.id);
    const openRow = buildFacturaciones(master.id, payload.months).find(
      (f) => f.billing_month === openBm
    );
    if (!openRow?.facturado_total_clp) throw new Error("the Vitest person's card lacks the state this test reads");

    expect(openRow.facturado_total_clp).toBe(
      (openRow.facturado_clp ?? 0) + (facturadoForeignIn(openRow, "usd")!.clp ?? 0)
    );
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
        .prepare(`SELECT id FROM accounts WHERE import_key = 'credit_card_master|santander|4321'`)
        .get() as { id: number } | undefined;
      if (!master) throw new Error("the Vitest person's card lacks the state this test reads");

      accountId = master.id;
      const purchaseDate = "2026-04-25";
      const principal = 120_000;
      const cuotas = 12;
      const firstCuota = Math.floor(principal / cuotas);

      const lastPdf = lastPdfBillingMonthForAccount(master.id);
      const openBm = billingMonthForManualLedgerPurchase(master.id);
      if (!lastPdf || !openBm) throw new Error("the Vitest person's card lacks the state this test reads");
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
        .prepare(`SELECT id FROM accounts WHERE import_key = 'credit_card_master|santander|4321'`)
        .get() as { id: number } | undefined;
      if (!master) throw new Error("the Vitest person's card lacks the state this test reads");

      accountId = master.id;
      const firstCuota = 15_000;
      const lastPdf = lastPdfBillingMonthForAccount(master.id);
      const openBm = billingMonthForManualLedgerPurchase(master.id);
      if (!lastPdf || !openBm) throw new Error("the Vitest person's card lacks the state this test reads");
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
