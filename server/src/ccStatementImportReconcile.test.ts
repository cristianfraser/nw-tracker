import { describe, expect, it } from "vitest";
import { billingMonthForCcStatement } from "./ccBillingMonth.js";
import { db } from "./db.js";
import {
  assertCcImportReconcilesOrThrow,
  buildProjectedReconcileRows,
  dedupeCrossSourceReconcileRows,
  reconcileBillingMonthMovements,
  sumParsedSectionsClp,
  type CcReconcileRow,
} from "./ccStatementImportReconcile.js";
import type { CcStatementCsvRecord } from "./ccStatementsImport.js";

function line(partial: Partial<CcReconcileRow>): CcReconcileRow {
  return {
    currency: "clp",
    installment_flag: false,
    merchant: "TEST SHOP",
    amount_clp: 10_000,
    amount_usd: 0,
    valor_cuota_mensual_clp: 0,
    valor_cuota_mensual_usd: 0,
    nro_cuota_current: null,
    nro_cuota_total: null,
    parser_layout: "compact",
    dedupe_key: "dk1",
    row_id: "r1",
    transaction_date: "01/05/2026",
    posting_date: null,
    ...partial,
  };
}

describe("ccStatementImportReconcile", () => {
  it("sums one-shot charges into operaciones", () => {
    const sums = sumParsedSectionsClp([
      line({ amount_clp: 1000, merchant: "SHOP A" }),
      line({ amount_clp: 2000, merchant: "SHOP B", dedupe_key: "dk2", row_id: "r2" }),
    ]);
    expect(sums.parsed_operaciones).toBe(3000);
    expect(sums.parsed_cargos_abonos).toBe(0);
  });

  it("fails when monto_facturado does not match movement sum", () => {
    const rows = [line({ amount_clp: 1000 })];
    const result = reconcileBillingMonthMovements("2026-05", rows, {
      monto_facturado: 5000,
      compras_cargos: null,
      source_pdf: "test.pdf",
    });
    expect(result.ok).toBe(false);
    expect(result.checks.some((c) => c.code === "monto_facturado" && !c.ok)).toBe(true);
  });

  it("dedupes web-paste vs PDF one-shot before summing", () => {
    const rows = dedupeCrossSourceReconcileRows([
      line({
        amount_clp: 180_000,
        merchant: "METLIFE CHILE SEGUROS DE",
        transaction_date: "20/05/2026",
        from_web_paste: true,
        dedupe_key: "wp1",
        row_id: "wp1",
      }),
      line({
        amount_clp: 180_000,
        merchant: "METLIFE CHILE SEGUROS",
        transaction_date: "25/05/2026",
        from_web_paste: false,
        dedupe_key: "pdf1",
        row_id: "pdf1",
      }),
      line({ amount_clp: 1000, merchant: "OTHER", dedupe_key: "dk3", row_id: "r3" }),
    ]);
    const sums = sumParsedSectionsClp(rows);
    expect(rows).toHaveLength(2);
    expect(sums.parsed_operaciones).toBe(181_000);
  });

  it("passes when operaciones+cargos match monto_facturado", () => {
    const rows = [
      line({ amount_clp: 4000, merchant: "SHOP" }),
      line({
        amount_clp: 500,
        merchant: "IMPUESTOS",
        dedupe_key: "dk-tax",
        row_id: "r-tax",
      }),
    ];
    const result = reconcileBillingMonthMovements("2026-05", rows, {
      monto_facturado: 4500,
      compras_cargos: 4000,
      source_pdf: "test.pdf",
    });
    expect(result.ok).toBe(true);
  });

  it("reconciles May 2026 4242 movements against imported PDF header", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const st = db
      .prepare(
        `SELECT source_pdf, monto_facturado, compras_cargos FROM cc_statements
         WHERE account_id = ? AND source_pdf LIKE '%2026-05-25%4111%'`
      )
      .get(master.id) as
      | { source_pdf: string; monto_facturado: number | null; compras_cargos: number | null }
      | undefined;
    if (!st?.monto_facturado) return;

    const rows = buildProjectedReconcileRows(master.id, "2026-05", [], new Set(), {
      pdfReconcileOnly: true,
    });
    const result = reconcileBillingMonthMovements("2026-05", rows, {
      monto_facturado: st.monto_facturado,
      compras_cargos: st.compras_cargos,
      source_pdf: st.source_pdf,
    });
    expect(result.ok).toBe(true);
  });

  it("assertCcImportReconcilesOrThrow skips when incoming is empty", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    expect(() => assertCcImportReconcilesOrThrow(master.id, [])).not.toThrow();
  });

  it("assertCcImportReconcilesOrThrow skips web-paste-only import when closed PDF exists", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const anchor = db
      .prepare(
        `SELECT statement_date, period_to FROM cc_statements
         WHERE account_id = ? AND source_pdf NOT LIKE 'import:web-paste%'
           AND monto_facturado IS NOT NULL AND monto_facturado > 0
         ORDER BY statement_date DESC LIMIT 1`
      )
      .get(master.id) as { statement_date: string; period_to: string | null } | undefined;
    if (!anchor) return;

    const closedBm = billingMonthForCcStatement({
      statement_date: anchor.statement_date,
      period_to: anchor.period_to,
    });
    if (!closedBm) return;

    const incoming: CcStatementCsvRecord[] = [
      {
        card_group: "santander",
        source_pdf: `import:web-paste|open|${closedBm}`,
        statement_date: "20/05/2026",
        transaction_date: "28/05/2026",
        merchant: "TEST WEB PASTE ONLY",
        amount_clp: "99999",
        installment_flag: "false",
        dedupe_key: `vitest-wp-only-${Date.now()}`,
        currency: "clp",
        parser_layout: "compact",
      },
    ];

    expect(() => assertCcImportReconcilesOrThrow(master.id, incoming)).not.toThrow();
  });
});
