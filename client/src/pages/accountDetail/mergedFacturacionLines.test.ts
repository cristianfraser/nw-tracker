import { describe, expect, it } from "vitest";
import type { CcStatementDto } from "../../types";
import { mergedFacturacionLines } from "./mergedFacturacionLines";

function stmt(
  partial: Partial<CcStatementDto> & Pick<CcStatementDto, "id" | "source_pdf" | "billing_month">
): CcStatementDto {
  return {
    account_id: 1,
    card_group: "santander",
    statement_date: "20/06/2026",
    statement_date_iso: "2026-06-20",
    period_from: null,
    period_to: null,
    pay_by: null,
    pay_by_iso: null,
    layout: "compact",
    currency: "clp",
    deuda_total: null,
    monto_facturado: null,
    lines: [],
    ...partial,
  };
}

describe("mergedFacturacionLines", () => {
  it("uses PDF lines only when a closed month has both PDF and web-paste", () => {
    const pdfLine = { id: 1, merchant: "PDF SHOP", amount_clp: 1000, installment_flag: false } as const;
    const webLine = { id: 2, merchant: "WEB SHOP", amount_clp: 2000, installment_flag: false } as const;
    const statements = [
      stmt({
        id: 10,
        billing_month: "2026-06",
        source_pdf: "2026-06-23 foo.pdf",
        monto_facturado: 1000,
        lines: [pdfLine as CcStatementDto["lines"][number]],
      }),
      stmt({
        id: 11,
        billing_month: "2026-06",
        source_pdf: "import:web-paste|open|2026-06",
        lines: [webLine as CcStatementDto["lines"][number]],
      }),
    ];
    const lines = mergedFacturacionLines(statements, "2026-06");
    expect(lines.map((l) => l.id)).toEqual([1]);
  });

  it("includes stale open-bucket lines when viewing the current open month", () => {
    const staleLine = { id: 3, merchant: "CARRY", amount_clp: 500, installment_flag: false } as const;
    const openLine = { id: 4, merchant: "JULY", amount_clp: 700, installment_flag: false } as const;
    const statements = [
      stmt({
        id: 12,
        billing_month: "2026-06",
        source_pdf: "import:web-paste|open|2026-06",
        lines: [staleLine as CcStatementDto["lines"][number]],
      }),
      stmt({
        id: 13,
        billing_month: "2026-07",
        source_pdf: "import:web-paste|open|2026-07",
        lines: [openLine as CcStatementDto["lines"][number]],
      }),
    ];
    const lines = mergedFacturacionLines(statements, "2026-07");
    expect(lines.map((l) => l.id).sort()).toEqual([3, 4]);
  });
});
