import { describe, expect, it, afterEach, vi } from "vitest";
import { db } from "./db.js";
import {
  applyOpenBillingMonthSaldoToNextMonth,
  billingDetailBalanceClp,
  buildBillingDetailByMonth,
  buildFacturaciones,
  facturadoClpFromOpenMonthStatementLines,
  paymentAbonosClpForBillingMonth,
} from "./ccBillingViews.js";
import {
  incrementalChargesClpForBillingMonth,
  postCloseLiveBalanceAdjustmentClp,
} from "./ccBillingBalances.js";
import { creditCardBillingDetailInactive } from "./ccBillingInactive.js";
import {
  ccInstallmentsDbApiPayload,
  ccLedgerMonthEndIso,
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
import * as chileDate from "./chileDate.js";

describe("billingDetailBalanceClp", () => {
  it("closed statement subtracts cuota a pagar del mes siguiente", () => {
    expect(billingDetailBalanceClp(100, 5_000_000, 561_728, true)).toBe(4_438_372);
  });

  it("open month does not subtract next cuota", () => {
    expect(billingDetailBalanceClp(100, 5_000_000, 561_728, false)).toBe(5_000_100);
  });

  it("projected plan month with no facturado uses open rule (saldo equals cupo)", () => {
    expect(billingDetailBalanceClp(null, 4_200_000, 300_000, false)).toBe(4_200_000);
  });
});

describe("applyOpenBillingMonthSaldoToNextMonth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("copies open month saldo and facturado to the next billing month without PDF cierre", () => {
    vi.spyOn(chileDate, "chileCalendarTodayYmd").mockReturnValue("2026-06-24");
    const rows = [
      {
        billing_month: "2026-06",
        as_of_date: "2026-06-23",
        as_of_kind: "manual" as const,
        total_facturado_actual_clp: 2_200_000,
        total_facturado_clp: 2_200_000,
        cupo_en_cuotas_clp: 3_800_000,
        cuota_a_pagar_next_mes_clp: 500_000,
        balance_total_clp: 6_000_000,
      },
      {
        billing_month: "2026-07",
        as_of_date: "2026-07-01",
        as_of_kind: "manual" as const,
        total_facturado_actual_clp: null,
        total_facturado_clp: 500_000,
        cupo_en_cuotas_clp: 3_200_000,
        cuota_a_pagar_next_mes_clp: 180_000,
        balance_total_clp: 3_700_000,
      },
    ];
    applyOpenBillingMonthSaldoToNextMonth(rows, 0, new Map());
    expect(rows[1]?.balance_total_clp).toBe(6_000_000);
    expect(rows[1]?.total_facturado_clp).toBe(2_200_000);
    expect(rows[1]?.cupo_en_cuotas_clp).toBe(3_200_000);
  });
});


type BillingDetailRowLike = {
  billing_month: string;
  as_of_date: string;
  as_of_kind: "statement" | "manual";
  balance_total_clp: number;
};

function postCloseAdjForRow(accountId: number, row: BillingDetailRowLike): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.as_of_date)) return 0;
  return postCloseLiveBalanceAdjustmentClp(
    accountId,
    row.as_of_date,
    ccLedgerMonthEndIso(row.billing_month)
  );
}

/** Open month balance = prior closed balance (pre post-close adj) + charges − payments this cycle. */
function expectedOpenRolledBalanceClp(
  accountId: number,
  det: readonly BillingDetailRowLike[],
  openBm: string
): number | null {
  const priorClosed = det
    .filter((r) => r.billing_month < openBm && r.as_of_kind === "statement")
    .sort((a, b) => b.billing_month.localeCompare(a.billing_month))[0];
  if (!priorClosed) return null;
  const netCharges =
    incrementalChargesClpForBillingMonth(accountId, openBm) -
    paymentAbonosClpForBillingMonth(accountId, openBm);
  return Math.round(
    priorClosed.balance_total_clp - postCloseAdjForRow(accountId, priorClosed) + netCharges
  );
}

describe("buildBillingDetailByMonth", () => {
  it("open month rolls prior closed balance into balance_total (facturado stays cycle-scoped)", () => {
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

    expect(openRow.as_of_kind).toBe("manual");
    expect(openRow.total_facturado_clp).toBeGreaterThan(0);
    // Open month: live debt = prior closed balance rolled forward + this cycle's net charges.
    expect(openRow.balance_total_clp).toBe(expectedOpenRolledBalanceClp(master.id, det, openBm));
    // Closed month: statement anchor + post-close activity through its calendar month-end.
    expect(may.balance_total_clp).toBe(
      Math.round(
        (may.total_facturado_clp ?? 0) +
          may.cupo_en_cuotas_clp -
          may.cuota_a_pagar_next_mes_clp +
          postCloseAdjForRow(master.id, may)
      )
    );
  });

  it("open month facturado is this cycle's charges plus cuota a pagar (not rolled)", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const openBm = billingMonthForManualLedgerPurchase(master.id);
    const lastPdf = lastPdfBillingMonthForAccount(master.id);
    if (!openBm || !lastPdf || ymCompare(openBm, lastPdf) <= 0) return;

    recomputeCcBillingMonthBalances(master.id);
    const payload = ccInstallmentsDbApiPayload(master.id);
    const det = buildBillingDetailByMonth(master.id, payload.months);
    const openRow = det.find((d) => d.billing_month === openBm);
    const may = det.find((d) => d.billing_month === lastPdf);
    if (!openRow || !may?.total_facturado_clp) return;

    // Facturado for the open cycle = únicos billed this cycle + cuota a pagar; the prior
    // closed month's facturado is NOT rolled in (that lives in deuda/saldo).
    const uniquo = facturadoClpFromOpenMonthStatementLines(master.id, openBm);
    const expected = uniquo + openRow.cuota_a_pagar_next_mes_clp;

    expect(openRow.total_facturado_clp).toBe(expected);
    // Open month did not roll the prior closed facturado into this cycle.
    expect(openRow.total_facturado_clp ?? 0).toBeLessThan(may.total_facturado_clp ?? 0);
    // …but the balance does roll the prior closed month's debt forward.
    expect(openRow.balance_total_clp).toBe(expectedOpenRolledBalanceClp(master.id, det, openBm));
  });

  it("open month includes charges when PAGO and purchases share web-paste bucket", () => {
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

    const chargeA = 100_000;
    const chargeB = 50_000;
    const pagoClp = 1_000_000;
    const dedupeBase = `vitest-pago-charges-${Date.now()}`;
    const insA = db
      .prepare(
        `INSERT INTO cc_statement_lines (
           statement_id, transaction_date, merchant, amount_clp, installment_flag, dedupe_key
         ) VALUES (?, ?, 'VITEST SHOP A', ?, 0, ?)`
      )
      .run(stmt.id, `${openBm}-10`, chargeA, `${dedupeBase}-a`);
    const insB = db
      .prepare(
        `INSERT INTO cc_statement_lines (
           statement_id, transaction_date, merchant, amount_clp, installment_flag, dedupe_key
         ) VALUES (?, ?, 'VITEST SHOP B', ?, 0, ?)`
      )
      .run(stmt.id, `${openBm}-11`, chargeB, `${dedupeBase}-b`);
    const insPago = db
      .prepare(
        `INSERT INTO cc_statement_lines (
           statement_id, transaction_date, merchant, amount_clp, installment_flag, dedupe_key
         ) VALUES (?, ?, 'PAGO', ?, 0, ?)`
      )
      .run(stmt.id, `${openBm}-12`, -pagoClp, `${dedupeBase}-pago`);

    try {
      const after = buildBillingDetailByMonth(master.id, payload.months).find(
        (d) => d.billing_month === openBm
      );
      expect(after).toBeDefined();
      // Open-month facturado tracks únicos billed this cycle (charges net of the PAGO,
      // floored at 0) plus cuota a pagar — both the purchases and the PAGO flow through.
      const uniquo = facturadoClpFromOpenMonthStatementLines(master.id, openBm);
      expect(after!.total_facturado_clp).toBe(uniquo + after!.cuota_a_pagar_next_mes_clp);
      const detAfter = buildBillingDetailByMonth(master.id, payload.months);
      expect(after!.balance_total_clp).toBe(
        expectedOpenRolledBalanceClp(master.id, detAfter, openBm)
      );
      // The large PAGO drives net únicos to zero (floored), below the pre-insert facturado.
      expect(uniquo).toBe(0);
    } finally {
      for (const id of [insA.lastInsertRowid, insB.lastInsertRowid, insPago.lastInsertRowid]) {
        db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`).run(id);
      }
    }
  });

  it("PAGO in open month reduces facturado and balance_total", () => {
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
      .run(stmt.id, `${openBm}-05`, -pagoClp, `vitest-pago-${Date.now()}`);

    try {
      expect(paymentAbonosClpForBillingMonth(master.id, openBm)).toBeGreaterThanOrEqual(pagoClp);
      const after = buildBillingDetailByMonth(master.id, payload.months).find(
        (d) => d.billing_month === openBm
      );
      expect(after).toBeDefined();
      // Facturado tracks the non-rolled cycle formula; a PAGO does not increase it.
      const uniquo = facturadoClpFromOpenMonthStatementLines(master.id, openBm);
      expect(after!.total_facturado_clp).toBe(uniquo + after!.cuota_a_pagar_next_mes_clp);
      const detAfter = buildBillingDetailByMonth(master.id, payload.months);
      expect(after!.balance_total_clp).toBe(
        expectedOpenRolledBalanceClp(master.id, detAfter, openBm)
      );
      // The PAGO reduces the rolled balance relative to the pre-insert detail.
      expect(after!.balance_total_clp).toBeLessThan(before.balance_total_clp);
      expect(after!.total_facturado_clp ?? 0).toBeLessThanOrEqual(before.total_facturado_clp ?? 0);
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
    if (!bucket) return;

    const notes = `credit_card_master|test|inactive-${Date.now()}`;
    const acctId = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, account_kind)
           VALUES (?, 'Vitest · inactive fixture', ?, 'master')`
        )
        .run(bucket.id, notes).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4)
       VALUES (?, 21, 20, '0000')`
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
      expect(creditCardBillingDetailInactive(acctId)).toBe(true);

      recomputeCcBillingMonthBalances(acctId);
      const payload = ccInstallmentsDbApiPayload(acctId);
      const det = buildBillingDetailByMonth(acctId, payload.months);
      expect(det.length).toBeGreaterThan(0);
      expect(det.every((row) => row.as_of_kind === "statement")).toBe(true);

      const todayMonth = new Date().toISOString().slice(0, 7);
      expect(det.some((row) => row.billing_month >= todayMonth)).toBe(false);
      expect(det[0]!.billing_month < todayMonth).toBe(true);
    } finally {
      db.prepare(`DELETE FROM cc_billing_month_balances WHERE account_id = ?`).run(acctId);
      db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(acctId);
      db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(acctId);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(acctId);
    }
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

  it("open month facturado_total equals uniquo statement lines plus cuota a pagar", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const openBm = billingMonthForManualLedgerPurchase(master.id);
    if (!openBm) return;

    const payload = ccInstallmentsDbApiPayload(master.id);
    const openRow = buildFacturaciones(master.id, payload.months).find(
      (f) => f.billing_month === openBm
    );
    if (!openRow?.is_open_month) return;

    const uniquo = facturadoClpFromOpenMonthStatementLines(master.id, openBm);
    const cuota = openRow.cuota_a_pagar_clp ?? 0;
    expect(openRow.facturado_total_clp).toBe(uniquo + cuota);
    expect(openRow.is_open_month).toBe(true);
  });

  it("open month facturado_total equals facturado_clp plus facturado_usd_clp", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const openBm = billingMonthForManualLedgerPurchase(master.id);
    if (!openBm) return;

    const payload = ccInstallmentsDbApiPayload(master.id);
    const openRow = buildFacturaciones(master.id, payload.months).find(
      (f) => f.billing_month === openBm
    );
    if (!openRow?.facturado_total_clp) return;

    expect(openRow.facturado_total_clp).toBe(
      (openRow.facturado_clp ?? 0) + (openRow.facturado_usd_clp ?? 0)
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
