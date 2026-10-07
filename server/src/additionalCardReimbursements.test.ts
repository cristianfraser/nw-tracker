import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import {
  buildAdditionalCardsSummary,
  isAdditionalCardChargeLine,
  matchCardReimbursements,
  type AdditionalCardChargeLineInput,
} from "./additionalCardReimbursements.js";
import { buildFlowsCheckingIncomePayload } from "./flowsCheckingInflows.js";
import { isCheckingIncomeKind } from "./flowsCheckingIncomeOverrides.js";
import { markCheckingExpenseRefund, unmarkCheckingExpenseRefund } from "./checkingExpenseRefunds.js";
import { buildFlowsExpensesPayload } from "./flowsExpenses.js";
import { assignFlowExpenseLineCategory } from "./assignFlowExpenseLineCategory.js";

// Synthetic registry (vitest.config.ts): primary 0781-style cards, additional card 4999.
const ADDITIONAL = "4999";
const PRIMARY = "4141";

function chargeLine(
  patch: Partial<AdditionalCardChargeLineInput> & { expense_month: string; amount_clp: number }
): AdditionalCardChargeLineInput {
  return {
    source: "cc",
    origin_card_last4: ADDITIONAL,
    primary_card_last4: PRIMARY,
    category_slug: "additional_card",
    line_role: "purchase",
    amount_usd_at_expense: patch.amount_clp / 1000,
    ...patch,
  };
}

describe("isAdditionalCardChargeLine", () => {
  it("counts only the additional cardholder's lines left in additional_card, as they bill", () => {
    expect(isAdditionalCardChargeLine(chargeLine({ expense_month: "2099-01", amount_clp: 5_000 }))).toBe(true);
    // The user's own card, or his own successor plastic, is his spend.
    expect(
      isAdditionalCardChargeLine(
        chargeLine({ expense_month: "2099-01", amount_clp: 5_000, origin_card_last4: PRIMARY })
      )
    ).toBe(false);
    expect(
      isAdditionalCardChargeLine(
        chargeLine({ expense_month: "2099-01", amount_clp: 5_000, origin_card_last4: "4112" })
      )
    ).toBe(false);
    // Recategorized by the user: his own spend.
    expect(
      isAdditionalCardChargeLine(
        chargeLine({ expense_month: "2099-01", amount_clp: 5_000, category_slug: "food" })
      )
    ).toBe(false);
    // An installment purchase total is the «Total» mode's view of cuotas already counted.
    expect(
      isAdditionalCardChargeLine(
        chargeLine({ expense_month: "2099-01", amount_clp: 5_000, line_role: "installment_purchase_total" })
      )
    ).toBe(false);
    expect(
      isAdditionalCardChargeLine(
        chargeLine({ expense_month: "2099-01", amount_clp: 5_000, line_role: "installment_cuota" })
      )
    ).toBe(true);
    expect(
      isAdditionalCardChargeLine(
        chargeLine({ expense_month: "2099-01", amount_clp: 5_000, source: "checking" })
      )
    ).toBe(false);
  });
});

describe("buildAdditionalCardsSummary", () => {
  it("sets reimbursements against charges per month and year with a running balance", () => {
    const summary = buildAdditionalCardsSummary(
      [
        chargeLine({ expense_month: "2098-12", amount_clp: 10_000 }),
        chargeLine({ expense_month: "2099-01", amount_clp: 6_000 }),
        chargeLine({ expense_month: "2099-01", amount_clp: 4_000 }),
        chargeLine({ expense_month: "2099-01", amount_clp: -1_000 }), // nota de crédito
        chargeLine({ expense_month: "2099-01", amount_clp: 99_000, category_slug: "food" }),
        // The cardholder's wires: refund lines in the category.
        chargeLine({ expense_month: "2099-01", amount_clp: -10_000, source: "checking", origin_card_last4: null, primary_card_last4: null }),
        chargeLine({ expense_month: "2099-02", amount_clp: -7_000, source: "checking", origin_card_last4: null, primary_card_last4: null }),
        // Another category's refund is not his.
        chargeLine({ expense_month: "2099-02", amount_clp: -3_000, source: "checking", category_slug: "food", origin_card_last4: null, primary_card_last4: null }),
      ]
    );
    expect(
      summary.by_month.map((r) => [r.period_month, r.charges_clp, r.reimbursements_clp, r.net_clp, r.balance_clp])
    ).toEqual([
      ["2098-12", 10_000, 0, 10_000, 10_000],
      ["2099-01", 9_000, 10_000, -1_000, 9_000],
      ["2099-02", 0, 7_000, -7_000, 2_000],
    ]);
    expect(summary.by_month[1]!.charge_count).toBe(3);
    expect(summary.by_month[1]!.as_of_date).toBe("2099-01-31");
    expect(
      summary.by_year.map((r) => [r.period_month, r.as_of_date, r.charges_clp, r.reimbursements_clp, r.balance_clp])
    ).toEqual([
      ["2098-12", "2098-12-31", 10_000, 0, 10_000],
      ["2099-12", "2099-12-31", 9_000, 17_000, 2_000],
    ]);
    expect(summary.totals).toMatchObject({
      charges_clp: 19_000,
      reimbursements_clp: 17_000,
      balance_clp: 2_000,
    });
    expect(summary.totals.balance_usd).toBeCloseTo(2);
  });

  it("reports a null USD figure when a line has no USD equivalent", () => {
    const summary = buildAdditionalCardsSummary([
      chargeLine({ expense_month: "2099-01", amount_clp: 1_000, amount_usd_at_expense: null }),
    ]);
    expect(summary.by_month[0]!.charges_usd).toBeNull();
    expect(summary.totals.balance_usd).toBeNull();
  });
});

describe("matchCardReimbursements", () => {
  const opts = { windowDays: 21, maxWindowCharges: 30 };

  it("pairs a credit with the oldest charges summing to it, else a set from the window", () => {
    const charges = [
      { id: 1, date: "2099-01-02", amount_clp: 5_100, merchant: "CAFE" },
      { id: 2, date: "2099-01-03", amount_clp: 4_300, merchant: "CAFE" },
      { id: 3, date: "2099-01-05", amount_clp: 5_100, merchant: "CAFE" },
      { id: 4, date: "2099-01-10", amount_clp: 30_000, merchant: "RESTAURANT" },
      { id: 5, date: "2099-01-11", amount_clp: 2_000, merchant: "CAFE" },
      { id: 6, date: "2099-01-20", amount_clp: 7_000, merchant: "CAFE" },
    ];
    const { matches, unpaid } = matchCardReimbursements(
      charges,
      [
        { movement_id: 101, date: "2099-01-06", amount_clp: 14_500 }, // 1+2+3
        { movement_id: 102, date: "2099-01-12", amount_clp: 2_000 }, // 5 (4 still owed)
        { movement_id: 103, date: "2099-01-21", amount_clp: 12_345 }, // nothing sums to it
      ],
      opts
    );
    expect(matches.map((m) => [m.credit.movement_id, m.kind, m.charge_ids])).toEqual([
      [101, "exact_fifo", [1, 2, 3]],
      [102, "exact_window", [5]],
      [103, "unmatched", [4]],
    ]);
    expect(matches[2]!.outstanding_before_clp).toBe(37_000);
    expect(matches[2]!.closest_fifo_delta_clp).toBe(12_345);
    expect([...unpaid]).toEqual([
      [4, 30_000 - 12_345],
      [6, 7_000],
    ]);
  });

  it("never pays a charge dated after the credit", () => {
    const { matches } = matchCardReimbursements(
      [{ id: 1, date: "2099-02-02", amount_clp: 1_000, merchant: null }],
      [{ movement_id: 1, date: "2099-02-01", amount_clp: 1_000 }],
      opts
    );
    expect(matches[0]!.kind).toBe("unmatched");
    expect(matches[0]!.charge_ids).toEqual([]);
  });
});

function insertCartolaCredit(occurredOn: string, amountClp: number, idx: number): number {
  const note =
    `import:cartola|${occurredOn.slice(0, 7)}|Agustinas|0000000000 Transf. Reembolso Test|` +
    `on:${occurredOn}|amt:${amountClp}|idx:${idx}`;
  const ins = db
    .prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
       VALUES (?, ?, 'clp', ?, ?, NULL)`
    )
    .run(checkingAccountId(), amountClp, occurredOn, note);
  return Number(ins.lastInsertRowid);
}

describe("checking credits as expense refunds", () => {
  it("is no income kind any more", () => {
    expect(isCheckingIncomeKind("card_reimbursement")).toBe(false);
  });

  it("moves a refund out of income into a negative gastos line in its category", () => {
    const movementId = insertCartolaCredit("2099-05-12", 12_340, 993101);
    try {
      const before = buildFlowsCheckingIncomePayload();
      expect(before.lines.some((l) => l.movement_id === movementId)).toBe(true);

      markCheckingExpenseRefund(movementId, "food");
      const after = buildFlowsCheckingIncomePayload();
      expect(after.lines.some((l) => l.movement_id === movementId)).toBe(false);
      expect(after.filtered_lines.some((l) => l.movement_id === movementId)).toBe(false);
      expect(after.refund_lines.find((l) => l.movement_id === movementId)).toMatchObject({ amount_clp: 12_340, category_slug: "food" });
      expect(after.monthly_totals["2099-05"] ?? 0).toBe((before.monthly_totals["2099-05"] ?? 0) - 12_340);

      const line = () => buildFlowsExpensesPayload().lines.find((l) => l.source === "checking" && l.statement_line_id === movementId);
      expect(line()).toMatchObject({ amount_clp: -12_340, category_slug: "food", expense_month: "2099-05", checking_refund: true });

      // The expenses page edits a refund's category like any line's.
      assignFlowExpenseLineCategory({ lineId: movementId, source: "checking", unique: true, categorySlug: "fun" });
      expect(line()?.category_slug).toBe("fun");

      unmarkCheckingExpenseRefund(movementId);
      expect(line()).toBeUndefined();
      expect(buildFlowsCheckingIncomePayload().lines.some((l) => l.movement_id === movementId)).toBe(true);
    } finally {
      unmarkCheckingExpenseRefund(movementId);
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(movementId);
    }
  });

  it("refuses a debit", () => {
    const movementId = insertCartolaCredit("2099-05-13", -5_000, 993102);
    try {
      expect(() => markCheckingExpenseRefund(movementId, "food")).toThrow(/not a checking credit/);
    } finally {
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(movementId);
    }
  });
});
