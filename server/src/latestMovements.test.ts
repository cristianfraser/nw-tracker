import { describe, expect, it } from "vitest";
import type { FlowCcExpenseLineRow } from "./flowsExpenses.js";
import type { FlowsOverviewIncome } from "./flowsOverview.js";
import type { LatestRowSources } from "./latestMovementOrder.js";
import { latestMovementRows } from "./latestMovements.js";
import { movementOn } from "./expenseLineDay.js";
import { lineMoneyFromBuilderFields } from "./lineMoney.js";

/** A finished line: its money as the «line money» step writes it. */
function line(over: Partial<FlowCcExpenseLineRow>): FlowCcExpenseLineRow {
  const l = {
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
  return { ...l, ...lineMoneyFromBuilderFields(l) };
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
const noDollars = new Set<number>();

function ids(rows: ReturnType<typeof latestMovementRows>): string[] {
  return rows.map((r) =>
    r.kind === "expense"
      ? `${r.line.source}:${r.line.statement_line_id}@${r.on}`
      : r.kind === "income"
        ? `${r.income.key}@${r.on}`
        : `${r.payment.key}@${r.on}`
  );
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
    expect(ids(latestMovementRows(lines, noIncome, known, 10, today, noDollars))).toEqual([
      "cc:8@2026-09-25",
      "cc:7@2026-09-09",
      "cc:-5@2026-09-07",
      "cc:2@2026-09-05",
      "cc:1@2026-09-01",
    ]);
    expect(latestMovementRows(lines, noIncome, known, 2, today, noDollars)).toHaveLength(2);
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
    const rows = latestMovementRows([line({ statement_line_id: 1, purchase_on: "2026-09-10" })], income, known, 10, today, noDollars);
    expect(ids(rows)).toEqual(["checking:40@2026-09-29", "cc:1@2026-09-10", "manual:3@2026-09-03"]);
    expect(rows[0]).toMatchObject({
      kind: "income",
      income: {
        income_kind: "salary",
        account_label: "Corriente",
        amount: { value: 900_000, currency: "clp" },
        converted: { value: 900_000, currency: "clp", rate_source: "native" },
      },
    });
    const inUsd = latestMovementRows([], income, known, 10, today, noDollars, [], "usd");
    expect(inUsd[0]).toMatchObject({ kind: "income", income: { converted: { value: 950, currency: "usd", rate_source: "day" } } });
    // Expense rows go over the wire without the builder fields.
    expect(rows[1]).toMatchObject({ kind: "expense", line: { amount: { value: 10_000, currency: "clp" } } });
    expect(rows[1]!.kind === "expense" && "amount_clp" in rows[1]!.line).toBe(false);
  });

  it("a dollar checking account's income is in dollars", () => {
    const income: FlowsOverviewIncome = {
      ...noIncome,
      lines: [
        { movement_id: 41, account_id: 7, account_label: "Checking (US)", received_on: "2026-09-29", amount_clp: 4_750_000, amount_usd: 5_000, description: "PAYROLL", source: "checking" },
      ],
    };
    const rows = latestMovementRows([], income, known, 10, today, new Set([7]));
    expect(rows[0]).toMatchObject({
      kind: "income",
      income: {
        amount: { value: 5_000, currency: "usd" },
        converted: { value: 4_750_000, currency: "clp", rate_source: "day" },
      },
    });
    const inUsd = latestMovementRows([], income, known, 10, today, new Set([7]), [], "usd");
    expect(inUsd[0]).toMatchObject({ kind: "income", income: { converted: { value: 5_000, currency: "usd", rate_source: "native" } } });
  });

  it("puts the newest arrival on top, ordered inside a run by when it happened", () => {
    const income: FlowsOverviewIncome = {
      ...noIncome,
      lines: [
        { movement_id: 40, account_id: 2, account_label: "Corriente", received_on: "2026-09-20", amount_clp: 24_500, amount_usd: null, description: "Transf", source: "checking" },
      ],
    };
    const lines = [
      line({ statement_line_id: 1, flow_id: 101, purchase_on: "2026-09-20" }), // the bar, fed by the 20:30 run
      line({ statement_line_id: 2, flow_id: 102, purchase_on: "2026-09-20" }), // fed by the 19:30 run
      line({ statement_line_id: 3, flow_id: 103, purchase_on: "2026-09-20" }), // written before the stamps
      line({ statement_line_id: 4, flow_id: 104, purchase_on: "2026-09-13" }), // a week late, in the 20:30 run
      line({ statement_line_id: 5, flow_id: 105, purchase_on: "2026-09-20" }), // entered by hand at 21:00
    ];
    const at = (hhmm: string) => Date.parse(`2026-09-20T${hhmm}:00-03:00`);
    const stampByFlow: Record<number, { atMs: number; seq: number }> = {
      101: { atMs: at("20:33"), seq: 10 },
      102: { atMs: at("19:33"), seq: 3 },
      104: { atMs: at("20:34"), seq: 12 },
      105: { atMs: at("21:00"), seq: 13 },
    };
    const sources: LatestRowSources = {
      runs: [
        { startedMs: at("19:30"), endMs: at("19:40") },
        { startedMs: at("20:30"), endMs: at("20:41") },
      ],
      flows: (refs) => refs.map((r) => (r.kind === "line" ? r.line.flow_id! : r.kind === "movement" ? 900 : null)),
      stamps: (refs) =>
        refs.map((r) =>
          r.kind === "line" ? (stampByFlow[r.line.flow_id!] ?? null) : r.kind === "movement" ? { atMs: at("20:36"), seq: 11 } : null
        ),
      // The transfer's mail was sent 20:15; the bar has no time of its own (≈ 20:01, mid-window).
      times: (refs) => refs.map((r) => (r.kind === "movement" ? { stated: [], bounds: [at("20:15")] } : { stated: [], bounds: [] })),
    };
    const rows = latestMovementRows(lines, income, known, 10, today, noDollars, [], "clp", undefined, sources);
    expect(ids(rows)).toEqual([
      "cc:5@2026-09-20",
      "checking:40@2026-09-20",
      "cc:4@2026-09-13",
      "cc:1@2026-09-20",
      "cc:2@2026-09-20",
      "cc:3@2026-09-20",
    ]);
    // Each row is known to the animation by its flow, whatever its key.
    expect(rows.map((r) => r.arrival_key)).toEqual(["flow:105", "flow:900", "flow:104", "flow:101", "flow:102", "flow:103"]);
    // A list that ends inside the newest run leaves the older rows out.
    expect(ids(latestMovementRows(lines, income, known, 2, today, noDollars, [], "clp", undefined, sources))).toEqual([
      "cc:5@2026-09-20",
      "checking:40@2026-09-20",
    ]);
  });

  it("throws on a category the catalog does not know", () => {
    expect(() => latestMovementRows([line({ category_slug: "nope" })], noIncome, known, 5, today, noDollars)).toThrow(
      /unknown category/
    );
  });
});
