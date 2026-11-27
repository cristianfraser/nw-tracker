import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsedStatements, type ParsedRecord } from "./test/parsedStatementRecords.js";
import { createTempCardMaster, deleteTempCardMaster } from "./test/tempCardMaster.js";
import { importStatementDocuments } from "./cards/statementLinePlanApply.js";
import {
  assertCcImportReconcilesOrThrow,
  CcStatementImportReconcileError,
  reconcileBillingMonthMovements,
  type CcReconcileRow,
} from "./ccStatementImportReconcile.js";

/**
 * The reconcile gate holds the PARSED LINES to the figures a statement prints: a candidate built
 * from printed figures alone (the printed TOTAL OPERACIONES standing in for the lines) never
 * verifies a statement by itself. Synthetic statements of a test-owned card.
 */

const DOC = "vitest-lines 2036-07-22 estado de cuenta tarjeta 4242.pdf";

/** A Santander peso statement's parser rows: `lines` are [merchant, pesos, layout?]. */
function santanderRecords(
  doc: string,
  lines: readonly [string, number, string?][],
  header: { monto: number; operaciones: number; pagadoAnterior?: number; saldoAnterior?: number }
): ParsedRecord[] {
  return lines.map(([merchant, amount, layout], i) => ({
    card_group: "santander",
    source_pdf: doc,
    statement_date: "22/07/2036",
    period_from: "23/06/2036",
    period_to: "22/07/2036",
    transaction_date: `${String(1 + (i % 20)).padStart(2, "0")}/07/2036`,
    merchant,
    amount_clp: String(amount),
    installment_flag: "false",
    dedupe_key: `vitest-lines-${doc}-${i}`,
    row_id: `vitest-lines-${doc}-r${i}`,
    currency: "clp",
    parser_layout: layout ?? "wide_master_simple",
    statement_monto_facturado: String(header.monto),
    pdf_total_operaciones: String(header.operaciones),
    statement_monto_pagado_anterior: String(header.pagadoAnterior ?? -50_000),
    statement_saldo_anterior: String(header.saldoAnterior ?? 0),
  }));
}

/** Seven purchases summing 100.000, two of them on one day each. */
const PURCHASES: [string, number, string?][] = [
  ["TIENDA UNO", 30_000],
  ["TIENDA DOS", 25_000],
  ["SUPERMERCADO DEMO", 20_000],
  ["FARMACIA DEMO", 12_000],
  ["CAFE DEMO", 11_500],
  ["PAYU *UBER TRIP", 700],
  ["SEG AUTO DEMO", 800],
];

/** Same day as the original (index), the other text rendering: spaced, or with a glued column. */
function doubledReadings(): [string, number, string?][] {
  return [...PURCHASES, ["PAYU   *UBER TRIP", 700, "compact_de_simple"], ["SEG AUTO DEMO          COMPRAS P.A.T.", 800, "compact_de_simple"]];
}

function withSameDayCopies(records: ParsedRecord[]): ParsedRecord[] {
  // The copies (last two rows) print on their originals' days (rows 5 and 6).
  const n = records.length;
  records[n - 2]!.transaction_date = records[5]!.transaction_date!;
  records[n - 1]!.transaction_date = records[6]!.transaction_date!;
  return records;
}

describe("reconcile gate: the parsed lines reproduce the printed figures", () => {
  let accountId = 0;
  beforeAll(() => {
    accountId = createTempCardMaster({ issuer: "santander", last4: "4242", key: "vitest-reconcile-lines" });
  });
  afterAll(() => {
    deleteTempCardMaster(accountId);
  });

  it("refuses a statement whose lines exceed the printed operaciones by doubled readings, naming the difference and the repeated rows", () => {
    // The printed TOTAL OPERACIONES equals the billed total by itself (no section 3), so a
    // candidate built from it reconciled whatever the lines were; with a payment in the period the
    // old gate also took the monto «from the header» once the lines were within 3% of it.
    const records = withSameDayCopies(santanderRecords(DOC, doubledReadings(), { monto: 100_000, operaciones: 100_000 }));
    let thrown: unknown;
    try {
      assertCcImportReconcilesOrThrow(accountId, parsedStatements(records));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CcStatementImportReconcileError);
    const err = thrown as CcStatementImportReconcileError;
    expect(err.code).toBe("statement_not_reconciled");
    expect(err.message).toMatch(/operaciones_lines: printed \$100\.000, parsed lines \$101\.500, difference \+\$1\.500/);
    expect(err.message).toMatch(/Rows printed more than once/);
    expect(err.message).toMatch(/PAYU \*UBER TRIP \$700 ×2/);
    expect(err.message).toMatch(/SEG AUTO DEMO \$800 ×2/);
    expect(err.message).toMatch(/extra copies sum \$1\.500/);
  });

  it("imports the same statement read once", () => {
    const results = assertCcImportReconcilesOrThrow(
      accountId,
      parsedStatements(santanderRecords(DOC, PURCHASES, { monto: 100_000, operaciones: 100_000 }))
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.unverified_reason).toBeNull();
    expect(results[0]!.checks.find((c) => c.code === "operaciones_lines")?.ok).toBe(true);
  });

  it("refuses lines short of the printed operaciones", () => {
    const short = PURCHASES.filter(([m]) => m !== "FARMACIA DEMO");
    expect(() =>
      assertCcImportReconcilesOrThrow(accountId, parsedStatements(santanderRecords(DOC, short, { monto: 100_000, operaciones: 100_000 })))
    ).toThrow(/operaciones_lines: printed \$100\.000, parsed lines \$88\.000, difference -\$12\.000/);
  });

  it("imports a statement that prints no total the lines can meet, and lists it as unverified", () => {
    // The Santander international JSON's header is all null: lines only.
    const records: ParsedRecord[] = [
      {
        card_group: "INTL",
        source_pdf: "vitest-lines 2036-07-22 estado de cuenta tarjeta usd 4242.pdf",
        statement_date: "22/07/2036",
        period_from: "23/06/2036",
        period_to: "22/07/2036",
        transaction_date: "05/07/2036",
        merchant: "APP STORE DEMO",
        amount_usd: "9,99",
        installment_flag: "false",
        dedupe_key: "vitest-lines-usd-0",
        row_id: "vitest-lines-usd-r0",
        currency: "usd",
        parser_layout: "international_usd",
      },
    ];
    const result = importStatementDocuments(accountId, parsedStatements(records));
    expect(result.keep_rows.wrote).toBe(true);
    expect(result.keep_rows.unverified_lines).toEqual([
      {
        statement: "vitest-lines 2036-07-22 estado de cuenta tarjeta usd 4242.pdf",
        currency: "usd",
        billing_month: "2036-07",
        reason: "the statement prints no total",
      },
    ]);
  });

  it("reconciles a period with a payment, a nota de crédito, a refund and a prepaid plan as before", () => {
    // Printed: TOTAL OPERACIONES 100.000 nets the 2.000 refund; section 3 = nota −5.000 + the
    // prepaid plan's 40.000 + 300 of tax; Monto Total Facturado = 100.000 + 35.300.
    const lines: [string, number, string?][] = [
      ...PURCHASES.map(([m, a]) => [m, a] as [string, number]),
      ["DEVOLUCION TIENDA DEMO", -2_000],
      ["TIENDA TRES", 2_000],
      ["NOTA DE CREDITO", -5_000],
      ["PREPAGO EN CUOTAS", 40_000],
      ["IMPTO. DECRETO LEY 3475", 300],
      ["MONTO CANCELADO", -50_000, "compact_payment_abono"],
    ];
    const results = assertCcImportReconcilesOrThrow(
      accountId,
      parsedStatements(
        santanderRecords("vitest-lines 2036-08-22 estado de cuenta tarjeta 4242.pdf", lines, {
          monto: 135_300,
          operaciones: 100_000,
        }).map((r) => ({ ...r, statement_date: "22/08/2036", period_from: "23/07/2036", period_to: "22/08/2036", transaction_date: r.transaction_date!.replace("/07/", "/08/") }))
      )
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.parsed_sums.parsed_operaciones_credits).toBe(-2_000);
    expect(results[0]!.parsed_sums.parsed_cargos_abonos).toBe(35_300);
  });
});

describe("reconcile rows: cuotas and BCI", () => {
  function row(partial: Partial<CcReconcileRow>): CcReconcileRow {
    return {
      currency: "clp",
      installment_flag: false,
      merchant: "TIENDA",
      amount_clp: 0,
      amount_usd: 0,
      valor_cuota_mensual_clp: 0,
      valor_cuota_mensual_usd: 0,
      nro_cuota_current: null,
      nro_cuota_total: null,
      parser_layout: "wide_master_simple",
      dedupe_key: null,
      row_id: null,
      transaction_date: "05/07/2036",
      posting_date: null,
      ...partial,
    };
  }

  it("does not bill a 00/N cuota row in TOTAL OPERACIONES, whatever layout read it", () => {
    const rows = [
      row({ amount_clp: 50_000, row_id: "a" }),
      row({ installment_flag: true, merchant: "PLAN NUEVO", amount_clp: 90_000, valor_cuota_mensual_clp: 30_000, nro_cuota_total: 3, parser_layout: "wide_master_precio_summary", row_id: "b" }),
      row({ installment_flag: true, merchant: "PLAN VIEJO", amount_clp: 60_000, valor_cuota_mensual_clp: 10_000, nro_cuota_current: 2, nro_cuota_total: 6, parser_layout: "wide_master_precio_summary", row_id: "c" }),
    ];
    const result = reconcileBillingMonthMovements("2036-07", rows, {
      monto_facturado: 60_000,
      compras_cargos: null,
      source_pdf: "vitest-cuotas.pdf",
      pdf_total_operaciones: 60_000,
      monto_pagado_anterior: -10_000,
    });
    expect(result.parsed_sums.parsed_operaciones).toBe(60_000);
    expect(result.ok).toBe(true);
  });

  it("BCI: refuses lines over the operaciones subtotal even inside the monto band, and keeps the hard monto gate", () => {
    const bci = (merchant: string, amount: number, id: string) =>
      row({ merchant, amount_clp: amount, parser_layout: "bci_lider_operaciones", row_id: id });
    const header = { monto_facturado: 200_000, compras_cargos: null, source_pdf: "vitest-bci.pdf", pdf_total_operaciones: 200_000 };
    const once = [bci("TIENDA UNO (T)", 150_000, "a"), bci("TIENDA DOS (T)", 50_000, "b")];
    expect(reconcileBillingMonthMovements("2036-07", once, header).ok).toBe(true);

    // 800 more is inside BCI's 0,5% monto band: only the operaciones check sees it.
    const doubled = reconcileBillingMonthMovements("2036-07", [...once, bci("TIENDA TRES (T)", 800, "c")], header);
    expect(doubled.ok).toBe(false);
    expect(doubled.checks.find((c) => c.code === "monto_facturado")?.ok).toBe(true);
    expect(doubled.checks.find((c) => c.code === "operaciones_lines")).toMatchObject({ ok: false, delta: 800 });

    const lost = reconcileBillingMonthMovements("2036-07", [once[0]!], header);
    expect(lost.checks.find((c) => c.code === "monto_facturado")?.ok).toBe(false);
  });

  it("reports, never refuses, an OCR'd scan whose lines miss a printed figure", () => {
    const rows = [row({ amount_clp: 95_000, parser_layout: "ocr_compact", row_id: "a" })];
    const result = reconcileBillingMonthMovements("2036-07", rows, {
      monto_facturado: 100_000,
      compras_cargos: null,
      source_pdf: "vitest-ocr.pdf",
      pdf_total_operaciones: 100_000,
    });
    expect(result.ok).toBe(true);
    expect(result.unverified_reason).toMatch(/^OCR scan: operaciones_lines printed 100000 vs parsed 95000/);
  });
});
