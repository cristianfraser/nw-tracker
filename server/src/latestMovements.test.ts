import { describe, expect, it } from "vitest";
import type { FlowCcExpenseLineRow } from "./flowsExpenses.js";
import type { FlowsOverviewIncome } from "./flowsOverview.js";
import { latestMovementRows, movementOn } from "./latestMovements.js";

function line(over: Partial<FlowCcExpenseLineRow>): FlowCcExpenseLineRow {
  return {
    source: "cc",
    statement_line_id: 1,
    account_id: 1,
    expense_month: "2026-09",
    billing_month: "2026-09",
    occurred_on: "2026-09-20",
    purchase_on: "2026-09-10",
    statement_date: "",
    amount_clp: 10_000,
    amount_usd: null,
    amount_usd_at_expense: 10,
    merchant: "VITEST SHOP",
    merchant_key: "vitest shop",
    category_slug: "food",
    category_unique: false,
    installment_flag: 0,
    nro_cuota_current: null,
    nro_cuota_total: null,
    purchase_month: "2026-09",
    line_role: "purchase",
    purchase_key: "k",
    purchase_notes: "",
    big_group_slug: null,
    origin_label: "·0000",
    origin_card_last4: null,
    primary_card_last4: null,
    ...over,
  } as FlowCcExpenseLineRow;
}

const noIncome: FlowsOverviewIncome = {
  lines: [],
  manual: [],
  work_earnings: [],
  income_kind_by_movement_id: {},
  payroll_period_by_movement_id: {},
};

const known = new Set(["food", "no_cuenta", "deposits", "checking_internal_transfer", "taxes"]);
const today = "2026-09-30";

function ids(rows: ReturnType<typeof latestMovementRows>): string[] {
  return rows.map((r) => (r.kind === "expense" ? `${r.line.source}:${r.line.statement_line_id}@${r.on}` : `${r.income.key}@${r.on}`));
}

describe("movementOn", () => {
  it("dates a card credit by its first-seen day, then a later posting date, then the close", () => {
    const credit = line({ amount_clp: -5_000, purchase_on: "2026-09-02", occurred_on: "2026-09-20" });
    expect(movementOn({ ...credit, first_seen_on: "2026-09-18", posting_on: "2026-09-15" }, today)).toBe("2026-09-18");
    expect(movementOn({ ...credit, posting_on: "2026-09-15" }, today)).toBe("2026-09-15");
    // A posting date no later than the transaction date says nothing.
    expect(movementOn({ ...credit, posting_on: "2026-09-02" }, today)).toBe("2026-09-20");
    expect(movementOn(credit, today)).toBe("2026-09-20");
    // An open facturación's close is ahead: the transaction date until a first-seen day exists.
    expect(movementOn({ ...credit, occurred_on: "2026-10-20" }, today)).toBe("2026-09-02");
  });

  it("keeps the purchase day for charges and for checking lines", () => {
    expect(movementOn(line({ first_seen_on: "2026-09-18" }), today)).toBe("2026-09-10");
    expect(movementOn(line({ source: "checking", amount_clp: -2_000, purchase_on: "2026-09-08" }), today)).toBe(
      "2026-09-08"
    );
  });
});

describe("latestMovementRows", () => {
  it("lists every «Total» line, counted or not, without cuota lines or payroll deductions", () => {
    const lines = [
      line({ statement_line_id: 1, purchase_on: "2026-09-01" }),
      line({ statement_line_id: 2, purchase_on: "2026-09-05", category_slug: "no_cuenta" }),
      line({ statement_line_id: 3, purchase_on: "2026-09-06", category_slug: "taxes", source: "payslip", pre_tax: true }),
      line({ statement_line_id: 4, purchase_on: "2026-09-07", line_role: "installment_cuota", installment_flag: 1, nro_cuota_current: 1, nro_cuota_total: 3 }),
      // A purchase in cuotas that paid another card's facturado: shown whole, though not counted.
      line({ statement_line_id: -5, purchase_on: "2026-09-07", line_role: "installment_purchase_total", installment_flag: 1, nro_cuota_total: 3, gastos_scope: "excluded", category_slug: "no_cuenta", amount_clp: 30_000 }),
      line({ statement_line_id: 6, purchase_on: "2026-09-08", gastos_scope: "split_only" }),
      line({ statement_line_id: 7, purchase_on: "2026-09-09", nota_credito_role: "annulled_purchase" }),
      line({ statement_line_id: 8, purchase_on: "2026-09-09", amount_clp: -10_000, nota_credito_role: "matched_nota", first_seen_on: "2026-09-25" }),
      line({ statement_line_id: 9, purchase_on: "2026-10-01" }),
    ];
    expect(ids(latestMovementRows(lines, noIncome, known, 10, today))).toEqual([
      "cc:8@2026-09-25",
      "cc:7@2026-09-09",
      "cc:-5@2026-09-07",
      "cc:2@2026-09-05",
      "cc:1@2026-09-01",
    ]);
    expect(latestMovementRows(lines, noIncome, known, 2, today)).toHaveLength(2);
  });

  it("interleaves income by day", () => {
    const income: FlowsOverviewIncome = {
      ...noIncome,
      lines: [
        { movement_id: 40, account_id: 2, account_label: "Corriente", received_on: "2026-09-29", amount_clp: 900_000, amount_usd: 950, description: "Remuneracion", source: "checking" },
      ],
      manual: [{ id: 3, amount_clp: 50_000, received_on: "2026-09-03", amount_usd: 52, source: "Regalo", note: null, origin: "manual" }],
      income_kind_by_movement_id: { 40: "salary" },
    };
    const rows = latestMovementRows([line({ statement_line_id: 1, purchase_on: "2026-09-10" })], income, known, 10, today);
    expect(ids(rows)).toEqual(["checking:40@2026-09-29", "cc:1@2026-09-10", "manual:3@2026-09-03"]);
    expect(rows[0]).toMatchObject({ kind: "income", income: { income_kind: "salary", account_label: "Corriente" } });
  });

  it("throws on a category the catalog does not know", () => {
    expect(() => latestMovementRows([line({ category_slug: "nope" })], noIncome, known, 5, today)).toThrow(
      /unknown category/
    );
  });
});
