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

/**
 * One line of the payslip as printed: a haber (earning) or a descuento (deduction), in the section
 * the payslip puts it when it shows one (taxable / non-taxable earnings, legal / other deductions).
 * The label is the payslip's own; an amount can be negative (an absence printed among the earnings).
 */
export const payslipLineSchema = z
  .object({
    position: z.number().int().nonnegative(),
    side: z.enum(["haber", "descuento"]),
    section: z.enum(["imponible", "no_imponible", "legal", "other"]).nullable(),
    label: z.string().min(1).max(200),
    amount: pesos,
  })
  .strict();

export type PayslipLine = z.infer<typeof payslipLineSchema>;

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
    /**
     * Every printed line, in order. The haberes add up to `earnings.total` and the descuentos to
     * `deductions.total` (when printed), and haberes − descuentos is `net_pay`.
     */
    lines: z.array(payslipLineSchema).min(1),
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
  .strict()
  .superRefine((p, ctx) => {
    const sum = (side: PayslipLine["side"]) => p.lines.filter((l) => l.side === side).reduce((s, l) => s + l.amount, 0);
    const haberes = sum("haber");
    const descuentos = sum("descuento");
    if (new Set(p.lines.map((l) => l.position)).size !== p.lines.length) {
      ctx.addIssue({ code: "custom", message: `${p.document}: a line position appears twice` });
    }
    if (p.earnings.total != null && haberes !== p.earnings.total) {
      ctx.addIssue({ code: "custom", message: `${p.document}: haberes lines add up to ${haberes}, total ${p.earnings.total}` });
    }
    if (p.deductions.total != null && descuentos !== p.deductions.total) {
      ctx.addIssue({ code: "custom", message: `${p.document}: descuentos lines add up to ${descuentos}, total ${p.deductions.total}` });
    }
    if (haberes - descuentos !== p.net_pay) {
      ctx.addIssue({ code: "custom", message: `${p.document}: haberes − descuentos = ${haberes - descuentos}, net pay ${p.net_pay}` });
    }
  });

export type Payslip = z.infer<typeof payslipSchema>;

export const employmentPayslipsKind = defineIngestKind({
  kind: "employment.payslips",
  schema_version: 2,
  description: "Payslips (liquidaciones de sueldo): every printed line, earnings, deductions and net pay per month and employer.",
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
  /** Dry run: each stored field the import would change, per payslip («new <document>» for a payslip not stored yet;
   * «lines <document>: …» when its printed lines differ from the stored ones). */
  changes: string[];
};
