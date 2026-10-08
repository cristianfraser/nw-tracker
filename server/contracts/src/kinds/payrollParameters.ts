import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

/**
 * A payroll month's legal parameters, as Previred's «Indicadores Previsionales» states them: UF and
 * UTM, the taxable caps (pension/health, unemployment insurance) in UF, each AFP's rate charged to
 * a dependent worker (the mandatory 10 % plus its commission), the employer's share into the
 * worker's account (pension reform, from August 2025; 0 before) and an indefinite contract's
 * unemployment-insurance rates. Rates are percents (10.46 = 10,46 %).
 */
const percent = z.number().nonnegative().max(100);
const periodMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export const payrollParametersMonthSchema = z
  .object({
    period_month: periodMonth,
    /** The document it was read from (its file name). */
    document: z.string().min(1).max(200),
    uf: z.number().positive(),
    utm: z.number().positive(),
    pension_cap_uf: z.number().positive(),
    unemployment_cap_uf: z.number().positive(),
    afp_worker_rates: z.record(z.string().regex(/^[a-z]+$/), percent).refine((r) => Object.keys(r).length > 0, "no AFP rates"),
    afp_employer_rate: percent,
    afc_worker_rate: percent,
    afc_employer_rate: percent,
  })
  .strict();

export type PayrollParametersMonth = z.infer<typeof payrollParametersMonthSchema>;

export const payrollParametersKind = defineIngestKind({
  kind: "payroll.parameters",
  schema_version: 1,
  description: "Payroll months' legal parameters (caps, AFP rates, employer pension share, unemployment rates) from Previred.",
  payload: z
    .object({
      months: z
        .array(payrollParametersMonthSchema)
        .min(1)
        .refine((m) => new Set(m.map((x) => x.period_month)).size === m.length, { message: "a month appears twice" }),
    })
    .strict(),
});

export type PayrollParametersPayload = z.infer<typeof payrollParametersKind.payload>;

/** `details` of an applied `payroll.parameters`. */
export type PayrollParametersApplyDetails = {
  months: number;
  /** Months stored for the first time. */
  added: string[];
  /** Months whose stored figures changed: «<month>: <field> <old> → <new>». */
  changed: string[];
};
