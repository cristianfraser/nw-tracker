import { z } from "zod";
import { payslipLineSchema } from "../kinds/employmentPayslips.js";

/**
 * JSON the Python parsers write and ingest reads (docs/untangle-plan.md F8). Each schema states
 * what the TypeScript reader takes (`ingest/src/...`, named per schema); the Python test
 * `ingest/python/shared_schema_test.py` validates each parser's output against the exported JSON
 * Schema. Extra keys a parser writes for its own report are allowed unless the schema is strict.
 */

const clpOrNull = z.number().int().nullable();

/** One payslip in `cfraser/payroll-parsing-output/all.json` (`ingest/src/payroll/payslips.ts` `ParsedPayrollRow`). */
export const parsedPayrollRowSchema = z.looseObject({
  source_pdf: z.string(),
  period_month: z.string().regex(/^\d{4}-\d{2}$/),
  employer_name: z.string(),
  employer_rut: z.string().nullable(),
  pay_period_label: z.string().nullable(),
  earning_type: z.enum(["salary", "severance"]).optional(),
  base_salary_clp: clpOrNull,
  colacion_clp: clpOrNull,
  movilizacion_clp: clpOrNull,
  gratificacion_clp: clpOrNull,
  total_imponible_clp: clpOrNull,
  total_no_imponible_clp: clpOrNull,
  total_haberes_clp: clpOrNull,
  desc_afp_clp: clpOrNull,
  desc_health_clp: clpOrNull,
  desc_tax_clp: clpOrNull,
  desc_cesantia_clp: clpOrNull,
  desc_apv_clp: clpOrNull,
  desc_other_clp: clpOrNull,
  total_descuentos_clp: clpOrNull,
  liquido_clp: z.number().int(),
  uf_mes: z.number().nullable(),
  utm_mes: z.number().nullable(),
  tope_previsional_uf: z.number().nullable(),
  tope_cesantia_uf: z.number().nullable(),
  format: z.string().optional(),
  lines: z.array(payslipLineSchema).optional(),
  pension_fund: z.string().nullable().optional(),
});

/** The payroll parser's index, `all.json` (`PayrollParseIndex`). */
export const parsedPayrollIndexSchema = z.looseObject({
  parser_version: z.string().optional(),
  rows: z.array(parsedPayrollRowSchema).optional(),
  failures: z.union([z.array(z.unknown()), z.number()]).optional(),
});

const parsedCartolaMovementSchema = z.looseObject({
  occurred_on: z.string(),
  amount_clp: z.number().int(),
  branch: z.string(),
  description: z.string(),
  document_no: z.string(),
});

/**
 * One cartola in `checking-cartolas-from-pdf.json` / `cuenta-vista-cartolas-from-pdf.json`, written
 * by `parse-checking-cartola-pdfs.py` and `parse-cuenta-vista-cartola-pdfs.py`
 * (`ingest/src/santander/cartolas.ts` `CartolaPdfEntry`).
 */
export const parsedCartolaPdfEntrySchema = z.looseObject({
  source_file: z.string(),
  period_month: z.string(),
  period_from: z.string().nullable(),
  period_to: z.string().nullable(),
  saldo_inicial_clp: clpOrNull,
  saldo_final_clp: clpOrNull,
  month_saldo_final_clp: z.record(z.string(), z.number().int()).nullable().optional(),
  movements: z.array(parsedCartolaMovementSchema),
  skipped: z.array(z.record(z.string(), z.unknown())).optional(),
  parse_status: z.enum(["ok", "unreadable", "error", "skipped"]),
  parse_error: z.string().nullable().optional(),
});

/** A cartola parser's whole file. */
export const parsedCartolaPdfFileSchema = z.looseObject({
  generated_at: z.string(),
  pdfs_dir: z.string(),
  cartolas: z.array(parsedCartolaPdfEntrySchema),
});

/** A grocery receipt's `parsed.json` (`parse-grocery-receipts.py`; `ingest/src/grocery/stagedReceipts.ts` `ParsedReceipt`). */
export const parsedGroceryReceiptSchema = z.looseObject({
  chain: z.string().optional(),
  boleta_number: z.string().nullable(),
  caja: z.string(),
  sucursal: z.string(),
  city: z.string().nullable(),
  purchased_at: z.string().nullable(),
  purchase_date_source: z.enum(["printed", "declared"]).nullable().optional(),
  template: z.string(),
  items: z.array(
    z.looseObject({
      position: z.number().int(),
      barcode: z.string().nullable(),
      description: z.string(),
      qty: z.string(),
      qty_unit: z.enum(["un", "kg"]),
      unit_price_clp: z.number().int(),
      total_clp: z.number().int(),
      discount_clp: z.number().int(),
      discount_labels: z.array(z.string()),
    })
  ),
  receipt_discounts: z.array(z.looseObject({ label: z.string(), amount_clp: z.number().int() })).optional(),
  payments: z.array(z.looseObject({ method: z.string(), amount_clp: z.number().int() })),
  total_printed_clp: clpOrNull,
  articles_declared: z.number().int().nullable(),
  mi_club_points: z.number().int().nullable(),
  parser_version: z.number().int(),
});

export type ParsedPayrollRowContract = z.infer<typeof parsedPayrollRowSchema>;
export type ParsedCartolaPdfEntry = z.infer<typeof parsedCartolaPdfEntrySchema>;
export type ParsedGroceryReceiptContract = z.infer<typeof parsedGroceryReceiptSchema>;
