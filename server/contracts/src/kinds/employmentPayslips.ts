import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

/**
 * Payslips (Chilean liquidaciones de sueldo): what an employer paid for a month and what it
 * withheld, as each payslip prints it. The feeder sends every payslip it read in one request,
 * because the server pairs each one with the deposit that paid it, and a deposit can pay only one
 * payslip: the pairing is decided over the whole set.
 */

const pesos = z.number().int();
const periodMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export const payslipSchema = z
  .object({
    /** The document it came from (its path under the feeder's archive): the payslip's identity. */
    document: z.string().min(1).max(512),
    period_month: periodMonth,
    employer: z.object({ name: z.string().min(1).max(200), rut: z.string().min(1).max(20).nullable() }).strict(),
    /** The period as printed («Septiembre 2025»), when it is. */
    pay_period_label: z.string().min(1).max(200).nullable(),
    /** `severance`: a finiquito. */
    kind: z.enum(["salary", "severance"]),
    /** Haberes as printed; null when the payslip prints no such line (or it was not read). */
    earnings: z
      .object({
        base_salary: pesos.nullable(),
        meal_allowance: pesos.nullable(),
        transport_allowance: pesos.nullable(),
        bonus: pesos.nullable(),
        taxable_total: pesos.nullable(),
        non_taxable_total: pesos.nullable(),
        total: pesos.nullable(),
      })
      .strict(),
    /** Descuentos as printed, positive. */
    deductions: z
      .object({
        pension: pesos.nullable(),
        health: pesos.nullable(),
        income_tax: pesos.nullable(),
        unemployment_insurance: pesos.nullable(),
        voluntary_pension: pesos.nullable(),
        other: pesos.nullable(),
        total: pesos.nullable(),
      })
      .strict(),
    /** Líquido a pagar: what reached the account. */
    net_pay: pesos,
    /** The month's indices the payslip prints (UF, UTM, contribution caps in UF). */
    indices: z
      .object({
        uf: z.number().positive().nullable(),
        utm: z.number().positive().nullable(),
        pension_cap_uf: z.number().positive().nullable(),
        unemployment_cap_uf: z.number().positive().nullable(),
      })
      .strict(),
  })
  .strict();

export type Payslip = z.infer<typeof payslipSchema>;

export const employmentPayslipsKind = defineIngestKind({
  kind: "employment.payslips",
  schema_version: 1,
  description: "Payslips (liquidaciones de sueldo): earnings, deductions and net pay per month and employer.",
  payload: z
    .object({
      /** False: report what the import would change, write nothing. */
      apply: z.boolean(),
      /** The feeder's parser version, kept on each stored payslip. */
      parser_version: z.string().min(1).max(64),
      payslips: z
        .array(payslipSchema)
        .min(1)
        .refine((p) => new Set(p.map((x) => x.document)).size === p.length, { message: "a document appears twice" }),
    })
    .strict(),
});

export type EmploymentPayslipsPayload = z.infer<typeof employmentPayslipsKind.payload>;

/** `details` of an applied `employment.payslips`. */
export type EmploymentPayslipsApplyDetails = {
  applied: boolean;
  payslips: number;
  /** Paired with their deposit (now, or by hand earlier). */
  linked: number;
  /** Newly paired this run: document → movement id. */
  links: { document: string; movement_id: number }[];
  /** No deposit pays it. */
  unmatched: { document: string; net_pay: number; period_month: string }[];
  /** Several deposits could pay it; none was chosen. */
  ambiguous: { document: string; movement_ids: number[] }[];
  /** Dry run: each stored field the import would change, per payslip («new <document>» for a payslip not stored yet). */
  changes: string[];
};
