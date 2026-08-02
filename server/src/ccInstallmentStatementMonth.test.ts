import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  ledgerInstallmentsPaid,
  planInstallmentsConsumed,
  purchaseFirstDueYm,
  scheduledPaymentsPlanBreakdownByMonth,
} from "./ccInstallmentLedgerDb.js";
import { paymentStatementMonthYm, statementPeriodMonthFromParsedRow } from "./ccInstallmentStatementMonth.js";

describe("statementPeriodMonthFromParsedRow", () => {
  it("prefers period_to over statement_date", () => {
    expect(
      statementPeriodMonthFromParsedRow({
        period_to: "25/04/2026",
        statement_date: "24/05/2026",
      })
    ).toBe("2026-04");
  });
});

describe("ledgerInstallmentsPaid statement-month timing", () => {
  const purchase = {
    id: 1,
    canonical_row_id: "ea86ae98c27a7a45",
    card_group: "A",
    purchase_date: "2026-03-25",
    total_amount_clp: 29_289,
    cuotas_totales: 3,
    merchant: "MUNICIPALIDAD DE MAIPU",
    description_merged: "MUNICIPALIDAD DE MAIPU",
    matched_baseline_purchase_id: null,
    source: "pdf",
    first_due_month: null,
  };

  it("counts 01/N on May statement as one paid when reference is May (00/N was April)", () => {
    const payList = [
      {
        id: 1,
        purchase_id: 1,
        pay_by_date: "2026-05-25",
        statement_date: "24/04/2026",
        statement_period_month: "2026-04",
        period_to_join: null,
        source_pdf: "apr.pdf",
        amount_clp: 9_763,
        cuota_current: null,
        cuota_total: null,
      },
      {
        id: 2,
        purchase_id: 1,
        pay_by_date: "2026-06-25",
        statement_date: "24/05/2026",
        statement_period_month: "2026-05",
        period_to_join: null,
        source_pdf: "may.pdf",
        amount_clp: 9_763,
        cuota_current: 1,
        cuota_total: null,
      },
    ];
    expect(ledgerInstallmentsPaid(purchase, payList, "2026-05")).toBe(1);
    expect(purchaseFirstDueYm(purchase, payList)).toBe("2026-05");
  });

  it("uses pay_by_date month only when statement month is missing (legacy)", () => {
    const payList = [
      {
        id: 1,
        purchase_id: 1,
        pay_by_date: "2026-05-25",
        statement_date: null,
        statement_period_month: null,
        period_to_join: null,
        source_pdf: null,
        amount_clp: 9_763,
        cuota_current: 1,
        cuota_total: null,
      },
    ];
    expect(paymentStatementMonthYm(payList[0]!)).toBe("2026-05");
    expect(ledgerInstallmentsPaid(purchase, payList, "2026-05")).toBe(1);
    expect(ledgerInstallmentsPaid(purchase, payList, "2026-04")).toBe(0);
  });
});

describe("planInstallmentsConsumed 00/N resumen", () => {
  const purchase = {
    id: 1,
    canonical_row_id: "95ffd7222a012819",
    card_group: "A",
    purchase_date: "2026-04-23",
    total_amount_clp: 92_918,
    cuotas_totales: 3,
    merchant: "TGR",
    description_merged: "TGR",
    matched_baseline_purchase_id: null,
    source: "pdf",
    first_due_month: null,
  };

  it("does not reduce remaining when only 00/N appears on statement", () => {
    const payList = [
      {
        id: 1,
        purchase_id: 1,
        pay_by_date: "2026-06-09",
        statement_date: "25/05/2026",
        statement_period_month: "2026-05",
        period_to_join: null,
        source_pdf: "may.pdf",
        amount_clp: 30_973,
        cuota_current: null,
        cuota_total: 3,
      },
    ];
    expect(ledgerInstallmentsPaid(purchase, payList, "2026-05")).toBe(0);
    expect(planInstallmentsConsumed(purchase, payList, "2026-05")).toBe(0);
    expect(Math.max(0, purchase.cuotas_totales - ledgerInstallmentsPaid(purchase, payList, "2026-05"))).toBe(3);
  });

  it("does not treat preamble 00/N as completing principal when indexed cuotas remain", () => {
    const purchase = {
      id: 1,
      canonical_row_id: "80e2b67810cc7793",
      card_group: "A",
      purchase_date: "2026-02-23",
      total_amount_clp: 205_000,
      cuotas_totales: 3,
      merchant: "FLOW   *PINARES.CL",
      description_merged: "FLOW   *PINARES.CL",
      matched_baseline_purchase_id: null,
      source: "pdf",
      first_due_month: null,
    };
    const payList = [
      {
        id: 1,
        purchase_id: 1,
        pay_by_date: "2026-04-09",
        statement_date: "24/03/2026",
        statement_period_month: "2026-03",
        period_to_join: null,
        source_pdf: "mar.pdf",
        amount_clp: 68_333,
        cuota_current: null,
        cuota_total: 3,
      },
      {
        id: 2,
        purchase_id: 1,
        pay_by_date: "2026-05-08",
        statement_date: "22/04/2026",
        statement_period_month: "2026-04",
        period_to_join: null,
        source_pdf: "apr.pdf",
        amount_clp: 68_333,
        cuota_current: 1,
        cuota_total: null,
      },
      {
        id: 3,
        purchase_id: 1,
        pay_by_date: "2026-06-09",
        statement_date: "25/05/2026",
        statement_period_month: "2026-05",
        period_to_join: null,
        source_pdf: "may.pdf",
        amount_clp: 68_333,
        cuota_current: 2,
        cuota_total: null,
      },
    ];
    expect(ledgerInstallmentsPaid(purchase, payList, "2026-05")).toBe(2);
    expect(ledgerInstallmentsPaid(purchase, payList, "2026-06")).toBe(2);
  });
});

describe("purchaseFirstDueYm closed-month clamp (manual plans)", () => {
  const accountIds: number[] = [];

  afterEach(() => {
    for (const id of accountIds) {
      db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    }
    accountIds.length = 0;
  });

  function makeAccountWithClosedMonths(periodsTo: string[]): number {
    const group = db.prepare(`SELECT id FROM asset_groups LIMIT 1`).get() as { id: number };
    const id = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, import_key) VALUES (?, ?, ?)`)
        .run(group.id, "Vitest · first-due clamp", `vitest-first-due-clamp|${periodsTo.join(",")}`)
        .lastInsertRowid
    );
    accountIds.push(id);
    for (const periodTo of periodsTo) {
      db.prepare(
        `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_to, layout, currency)
         VALUES (?, 'A', ?, ?, ?, 'compact', 'clp')`
      ).run(id, `vitest clamp ${periodTo}.pdf`, periodTo, periodTo);
    }
    return id;
  }

  const manualPurchase = (overrides: Partial<{ purchase_date: string; first_due_month: string | null }>) => ({
    id: 1,
    canonical_row_id: "clamp-test",
    card_group: "santander",
    purchase_date: "2026-06-30",
    total_amount_clp: 1_200_000,
    cuotas_totales: 3,
    merchant: "EXPRESS PLAZA L",
    description_merged: "EXPRESS PLAZA L",
    matched_baseline_purchase_id: null,
    source: "manual",
    first_due_month: null,
    ...overrides,
  });

  it("advances an evidence-less manual plan out of a fully-closed month to the first pending one", () => {
    // Default cycle 21→20: purchase 2026-06-30 → own cycle 2026-07; July's statement is imported.
    const accountId = makeAccountWithClosedMonths(["20/06/2026", "20/07/2026"]);
    expect(purchaseFirstDueYm(manualPurchase({}), [], accountId)).toBe("2026-08");
  });

  it("keeps the date-based guess while that month's statement is still pending (no drift)", () => {
    const accountId = makeAccountWithClosedMonths(["20/06/2026"]);
    expect(purchaseFirstDueYm(manualPurchase({}), [], accountId)).toBe("2026-07");
  });

  it("clamps a stored web-paste first_due_month once its month closes without evidence", () => {
    const accountId = makeAccountWithClosedMonths(["20/06/2026", "20/07/2026"]);
    expect(purchaseFirstDueYm(manualPurchase({ first_due_month: "2026-07" }), [], accountId)).toBe(
      "2026-08"
    );
  });

  it("never clamps statement cuota evidence", () => {
    const accountId = makeAccountWithClosedMonths(["20/06/2026", "20/07/2026"]);
    const payList = [
      {
        id: 1,
        purchase_id: 1,
        pay_by_date: "2026-08-10",
        statement_date: "20/07/2026",
        statement_period_month: "2026-07",
        period_to_join: null,
        source_pdf: "vitest clamp 20/07/2026.pdf",
        amount_clp: 400_000,
        cuota_current: 1,
        cuota_total: null,
      },
    ];
    expect(purchaseFirstDueYm(manualPurchase({}), payList, accountId)).toBe("2026-07");
  });
});

describe("purchaseFirstDueYm 00/N preamble", () => {
  const purchase = {
    id: 1,
    canonical_row_id: "blundstone-test",
    card_group: "A",
    purchase_date: "2026-06-03",
    total_amount_clp: 189_900,
    cuotas_totales: 3,
    merchant: "BLUNDSTONE MUT",
    description_merged: "BLUNDSTONE MUT",
    matched_baseline_purchase_id: null,
    source: "pdf",
    first_due_month: null,
  };

  it("anchors first indexed cuota on the statement month after the 00/03 preamble", () => {
    const payList = [
      {
        id: 1,
        purchase_id: 1,
        pay_by_date: "2026-07-10",
        statement_date: "20/06/2026",
        statement_period_month: "2026-06",
        period_to_join: null,
        source_pdf: "june.pdf",
        amount_clp: 63_300,
        cuota_current: 0,
        cuota_total: null,
      },
    ];
    expect(purchaseFirstDueYm(purchase, payList)).toBe("2026-07");
  });

  it("schedules 01/03 in July after June 00/03 only", () => {
    const payList = [
      {
        id: 1,
        purchase_id: 1,
        pay_by_date: "2026-07-10",
        statement_date: "20/06/2026",
        statement_period_month: "2026-06",
        period_to_join: null,
        source_pdf: "june.pdf",
        amount_clp: 63_300,
        cuota_current: 0,
        cuota_total: null,
      },
    ];
    const paymentsByPurchase = new Map([[1, payList]]);
    const breakdown = scheduledPaymentsPlanBreakdownByMonth([purchase], paymentsByPurchase);
    const jul = breakdown.get("2026-07") ?? [];
    expect(jul).toHaveLength(1);
    expect(jul[0]!.installment_index).toBe(0);
    expect(jul[0]!.installment_count).toBe(3);
    expect(jul[0]!.amount_clp).toBe(63_300);
    expect(breakdown.get("2026-08") ?? []).toHaveLength(1);
  });
});
