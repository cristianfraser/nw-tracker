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
import {
  deleteCheckingIncomeMovementOverride,
  isCheckingIncomeKind,
  loadCardReimbursementCredits,
  upsertCheckingIncomeMovementOverride,
} from "./flowsCheckingIncomeOverrides.js";

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
    category_slug: "no_cuenta",
    line_role: "purchase",
    amount_usd_at_expense: patch.amount_clp / 1000,
    ...patch,
  };
}

describe("isAdditionalCardChargeLine", () => {
  it("counts only the additional cardholder's lines left in no_cuenta, as they bill", () => {
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
      ],
      [
        { movement_id: 1, received_on: "2099-01-03", amount_clp: 10_000, amount_usd: 10 },
        { movement_id: 2, received_on: "2099-02-10", amount_clp: 7_000, amount_usd: 7 },
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
    const summary = buildAdditionalCardsSummary(
      [chargeLine({ expense_month: "2099-01", amount_clp: 1_000, amount_usd_at_expense: null })],
      []
    );
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

describe("card_reimbursement income kind", () => {
  it("is a valid kind", () => {
    expect(isCheckingIncomeKind("card_reimbursement")).toBe(true);
    expect(isCheckingIncomeKind("reimbursement")).toBe(false);
  });

  it("moves the credit out of income into card_reimbursement_lines", () => {
    const movementId = insertCartolaCredit("2099-05-12", 12_340, 993101);
    try {
      const before = buildFlowsCheckingIncomePayload();
      expect(before.lines.some((l) => l.movement_id === movementId)).toBe(true);
      expect(before.card_reimbursement_lines.some((l) => l.movement_id === movementId)).toBe(false);

      upsertCheckingIncomeMovementOverride(movementId, { income_kind: "card_reimbursement" });
      const after = buildFlowsCheckingIncomePayload();
      expect(after.lines.some((l) => l.movement_id === movementId)).toBe(false);
      expect(after.filtered_lines.some((l) => l.movement_id === movementId)).toBe(false);
      const line = after.card_reimbursement_lines.find((l) => l.movement_id === movementId);
      expect(line?.amount_clp).toBe(12_340);
      expect(after.monthly_totals["2099-05"] ?? 0).toBe((before.monthly_totals["2099-05"] ?? 0) - 12_340);

      const credit = loadCardReimbursementCredits().find((c) => c.movement_id === movementId);
      expect(credit).toMatchObject({ received_on: "2099-05-12", amount_clp: 12_340 });
    } finally {
      deleteCheckingIncomeMovementOverride(movementId);
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(movementId);
    }
  });
});
