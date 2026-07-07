import { describe, expect, it } from "vitest";
import {
  flowLinesForBillingStatementMonth,
  flowLinesForFacturacionMonth,
} from "./flowLinesForStatementMonth";
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
    big_group_slug: null,
    origin_label: "4242",
    amount_usd_at_expense: null,
    origin_card_last4: null,
    primary_card_last4: null,
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

describe("flowLinesForFacturacionMonth", () => {
  it("open month includes deduced installment cuotas for the billing month", () => {
    const statements: CcStatementDto[] = [
      {
        id: 20,
        billing_month: "2026-07",
        statement_date: "20/07/2026",
        currency: "clp",
        source_pdf: "import:web-paste|open|2026-07",
        lines: [{ ...line({ statement_line_id: 200, line_role: "purchase" }), id: 200 }],
      } as unknown as CcStatementDto,
    ];
    const flows = [
      line({
        statement_line_id: 200,
        line_role: "purchase",
        billing_month: "2026-07",
        amount_clp: 50_000,
      }),
      line({
        statement_line_id: -2_000_000_042,
        line_role: "installment_cuota",
        billing_month: "2026-07",
        amount_clp: 18_660,
        nro_cuota_current: 2,
        nro_cuota_total: 12,
      }),
      line({
        statement_line_id: -2_000_000_043,
        line_role: "installment_cuota",
        billing_month: "2026-08",
        amount_clp: 18_660,
        nro_cuota_current: 3,
        nro_cuota_total: 12,
      }),
    ];
    const scoped = flowLinesForFacturacionMonth(flows, statements, 1, {
      billing_month: "2026-07",
      is_open_month: true,
    });
    expect(scoped.map((ln) => ln.statement_line_id).sort()).toEqual([-2_000_000_042, 200]);
  });

  it("closed month excludes deduced installment cuotas", () => {
    const statements: CcStatementDto[] = [
      {
        id: 10,
        billing_month: "2026-06",
        statement_date: "23/06/2026",
        currency: "clp",
        source_pdf: "2026-06-23 foo.pdf",
        lines: [{ ...line({ statement_line_id: 100 }), id: 100 }],
      } as unknown as CcStatementDto,
    ];
    const flows = [
      line({ statement_line_id: 100 }),
      line({
        statement_line_id: -2_000_000_001,
        line_role: "installment_cuota",
        billing_month: "2026-08",
        amount_clp: 5000,
      }),
    ];
    const scoped = flowLinesForFacturacionMonth(flows, statements, 1, {
      billing_month: "2026-06",
      is_open_month: false,
    });
    expect(scoped.map((ln) => ln.statement_line_id)).toEqual([100]);
  });
});
