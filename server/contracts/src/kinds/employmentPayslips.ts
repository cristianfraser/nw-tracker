import { z } from "zod";
import { centsSchema, isoDateSchema, yearMonthSchema } from "../formats/index.js";
import { defineIngestKind } from "../defineKind.js";

/**
 * Payslips: what an employer paid and what it withheld, as each payslip prints it, under the law
 * of its jurisdiction — a Chilean liquidación de sueldo (`cl`: monthly, pesos) or a US W-2 pay stub
 * (`us`: biweekly or semi-monthly, dollars). The feeder sends every payslip it read in one request,
 * because the server pairs each one with the deposit that paid it, and a deposit can pay only one
 * payslip: the pairing is decided over the whole set.
 *
 * v4 (2026-11-09): every payslip names its `jurisdiction` and `pay_period`; the US pay stub.
 */

const pesos = z.number().int();

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

/** A Chilean liquidación. */
export const clPayslipSchema = z
  .object({
    jurisdiction: z.literal("cl"),
    pay_period: z.literal("monthly"),
    /** The document it came from (its path under the feeder's archive): the payslip's identity. */
    document: z.string().min(1).max(512),
    period_month: yearMonthSchema,
    employer: z.object({ name: z.string().min(1).max(200), rut: z.string().min(1).max(20).nullable() }).strict(),
    /** The period as printed («Septiembre 2025»), when it is. */
    pay_period_label: z.string().min(1).max(200).nullable(),
    /** `severance`: a finiquito. */
    kind: z.enum(["salary", "severance"]),
    /** The AFP the pension contribution went to, as the payslip names it (lowercase); null when it names none. */
    pension_fund: z.string().regex(/^[a-z]+$/).nullable().optional(),
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

export type ClPayslip = z.infer<typeof clPayslipSchema>;

const dollars = centsSchema;

/**
 * One line of a US pay stub: an earning (`haber`), a deduction (`descuento`) or a memo line the
 * stub prints that is neither paid nor withheld (the employer's 401(k) match), in dollars.
 */
export const usPayslipLineSchema = z
  .object({
    position: z.number().int().nonnegative(),
    side: z.enum(["haber", "descuento", "memo"]),
    label: z.string().min(1).max(200),
    amount: dollars,
  })
  .strict();

export type UsPayslipLine = z.infer<typeof usPayslipLineSchema>;

/** A US W-2 pay stub (federal; no state withholding yet). Amounts in dollars, to the cent. */
export const usPayslipSchema = z
  .object({
    jurisdiction: z.literal("us"),
    pay_period: z.enum(["biweekly", "semi_monthly"]),
    /** The document it came from: the payslip's identity (several stubs share a month). */
    document: z.string().min(1).max(512),
    /** The pay date's month. */
    period_month: yearMonthSchema,
    pay_date: isoDateSchema,
    /** The period worked, as printed. */
    period_start: isoDateSchema,
    period_end: isoDateSchema,
    employer: z.object({ name: z.string().min(1).max(200), ein: z.string().regex(/^\d{2}-\d{7}$/).nullable() }).strict(),
    kind: z.literal("salary"),
    /** The Form W-4 (2020 or later) the employer withholds with: Step 1(c) only. */
    w4: z.object({ filing_status: z.enum(["single", "married_jointly"]) }).strict(),
    /** Gross pay: the earnings lines' sum. */
    gross_pay: dollars,
    /** The deductions lines' sum. */
    total_deductions: dollars,
    /** Net pay: what reached the account. */
    net_pay: dollars,
    lines: z.array(usPayslipLineSchema).min(1),
  })
  .strict()
  .superRefine((p, ctx) => {
    const sum = (side: UsPayslipLine["side"]) =>
      Math.round(p.lines.filter((l) => l.side === side).reduce((s, l) => s + l.amount * 100, 0)) / 100;
    const gross = sum("haber");
    const deductions = sum("descuento");
    const same = (a: number, b: number) => Math.abs(a - b) < 0.005;
    if (new Set(p.lines.map((l) => l.position)).size !== p.lines.length) {
      ctx.addIssue({ code: "custom", message: `${p.document}: a line position appears twice` });
    }
    if (p.pay_date.slice(0, 7) !== p.period_month) {
      ctx.addIssue({ code: "custom", message: `${p.document}: period_month ${p.period_month} is not the pay date's month (${p.pay_date})` });
    }
    if (p.period_end < p.period_start) {
      ctx.addIssue({ code: "custom", message: `${p.document}: the period ends (${p.period_end}) before it starts (${p.period_start})` });
    }
    if (!same(gross, p.gross_pay)) {
      ctx.addIssue({ code: "custom", message: `${p.document}: earnings lines add up to ${gross}, gross pay ${p.gross_pay}` });
    }
    if (!same(deductions, p.total_deductions)) {
      ctx.addIssue({ code: "custom", message: `${p.document}: deduction lines add up to ${deductions}, total ${p.total_deductions}` });
    }
    if (!same(gross - deductions, p.net_pay)) {
      ctx.addIssue({ code: "custom", message: `${p.document}: gross − deductions = ${gross - deductions}, net pay ${p.net_pay}` });
    }
  });

export type UsPayslip = z.infer<typeof usPayslipSchema>;

export const payslipSchema = z.discriminatedUnion("jurisdiction", [clPayslipSchema, usPayslipSchema]);

export type Payslip = z.infer<typeof payslipSchema>;

export const employmentPayslipsKind = defineIngestKind({
  kind: "employment.payslips",
  schema_version: 4,
  description:
    "Payslips per jurisdiction (Chilean liquidaciones, US W-2 pay stubs): every printed line, earnings, deductions and net pay per pay period and employer.",
  ref: "read",
  payload: z
    .object({
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
