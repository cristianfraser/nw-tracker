import { describe, expect, it } from "vitest";
import { flowLinesForBillingStatementMonth } from "./flowLinesForStatementMonth";
import type { CcStatementDto, FlowCcExpenseLineRow } from "../../types";

function line(
  partial: Partial<FlowCcExpenseLineRow> & Pick<FlowCcExpenseLineRow, "statement_line_id">
): FlowCcExpenseLineRow {
  return {
    source: "cc",
    account_id: 1,
    expense_month: "2026-05",
    billing_month: "2026-05",
    purchase_month: "2026-04",
    line_role: "purchase",
    occurred_on: "2026-05-20",
    purchase_on: "2026-04-15",
    statement_date: "20/05/2026",
    amount_clp: 1000,
    amount_usd: null,
    merchant: "SHOP",
    merchant_key: "SHOP",
    category_slug: "unclassified",
    category_unique: false,
    installment_flag: 0,
    nro_cuota_current: null,
    nro_cuota_total: null,
    purchase_key: "k",
    purchase_notes: "",
    origin_label: "4242",
    ...partial,
  };
}

describe("flowLinesForBillingStatementMonth", () => {
  it("excludes ledger fill and purchase totals not on imported statement rows", () => {
    const statements: CcStatementDto[] = [
      {
        id: 10,
        billing_month: "2026-05",
        statement_date: "20/05/2026",
        currency: "clp",
        lines: [{ ...line({ statement_line_id: 100, line_role: "purchase" }), id: 100 }],
      } as unknown as CcStatementDto,
    ];
    const flows = [
      line({ statement_line_id: 100, line_role: "purchase" }),
      line({
        statement_line_id: -2_000_000_001,
        line_role: "installment_cuota",
        billing_month: "2026-05",
        amount_clp: 5000,
        nro_cuota_current: 3,
        nro_cuota_total: 12,
      }),
      line({
        statement_line_id: -500,
        line_role: "installment_purchase_total",
        billing_month: "2026-02",
        amount_clp: 50_000,
        category_statement_line_id: 100,
        nro_cuota_total: 3,
      }),
    ];
    const scoped = flowLinesForBillingStatementMonth(flows, statements, 1, "2026-05");
    expect(scoped.map((ln) => ln.statement_line_id)).toEqual([100]);
  });
});
