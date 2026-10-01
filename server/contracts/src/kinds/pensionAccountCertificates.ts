import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

/** `YYYY-MM`: the month a contribution is FOR (período de cotización), not when it was paid. */
const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const rutSchema = z.string().regex(/^\d{1,3}(?:\.\d{3})*-[\dK]$/);
/** Cuotas print with two decimals. */
const cuotasSchema = z
  .number()
  .nonnegative()
  .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, { message: "cuotas print with two decimals" });

/** The certificate's own header: who issued it, when, and the períodos it covers. */
const certificateHeaderSchema = z
  .object({
    folio: z.string().min(1).max(64),
    issued_on: z.iso.date(),
    from_period: periodSchema,
    to_period: periodSchema,
  })
  .strict();

/** One contribution as the contributions certificate prints it, with the day the fund received it. */
export const pensionContributionSchema = z
  .object({
    period: periodSchema,
    description: z.string().min(1).max(120),
    /** Fecha caja: the day the payment reached the fund. */
    paid_on: z.iso.date(),
    pesos: z.number().int().nonnegative(),
    cuotas: cuotasSchema,
    valor_cuota: z.number().positive(),
    payer_rut: rutSchema,
    fund: z.string().regex(/^[A-E]$/),
  })
  .strict();

export type PensionContribution = z.infer<typeof pensionContributionSchema>;

/**
 * One movement of the movements certificate: every credit and debit of the account in cuotas,
 * dated only by its período. `code` is the fund manager's movement code (110101 a contribution,
 * 111138 a contribution paid by the unemployment insurance, 120506 a commission…).
 */
export const pensionMovementSchema = z
  .object({
    period: periodSchema,
    direction: z.enum(["credit", "debit"]),
    code: z.string().regex(/^\d{6}$/),
    description: z.string().min(1).max(120),
    pesos: z.number().int().nonnegative(),
    cuotas: cuotasSchema,
    valor_cuota: z.number().positive(),
    /** Null on a row with no employer (a withdrawal). */
    employer_rut: rutSchema.nullable(),
    fund: z.string().regex(/^[A-E]$/),
  })
  .strict();

export type PensionMovement = z.infer<typeof pensionMovementSchema>;

/** A row of the site's recent-movements list, as listed (dated by when it was credited). */
export const pensionRecentMovementSchema = z
  .object({
    credited_on: z.iso.date(),
    period: periodSchema,
    code: z.string().regex(/^\d{6}$/),
    description: z.string().min(1).max(120),
    pesos: z.number().int().nonnegative(),
    cuotas: cuotasSchema,
  })
  .strict();

/**
 * One read of a pension account: the balance the fund manager states, its recent-movements list,
 * and the two certificates it issues on request — contributions (each with its payment day) and
 * movements (everything, in cuotas, by período). The server pairs them with the account's cuota
 * ledger and adds what the ledger lacks.
 */
export const pensionAccountCertificatesKind = defineIngestKind({
  kind: "pension_account.certificates",
  schema_version: 1,
  description: "A pension account's stated balance, recent movements and its two certificates.",
  payload: z
    .object({
      provider: z.enum(["afp_uno"]),
      /** The mandatory account (cuenta obligatoria). */
      product: z.enum(["mandatory"]),
      fund: z.string().regex(/^[A-E]$/),
      apply: z.boolean(),
      read_at: z.iso.datetime({ offset: true }),
      balance: z
        .object({ cuotas: z.number().nonnegative(), valor_cuota: z.number().positive(), pesos: z.number().int().nonnegative() })
        .strict(),
      recent_movements: z.array(pensionRecentMovementSchema),
      contributions: certificateHeaderSchema.extend({ rows: z.array(pensionContributionSchema) }).strict(),
      movements: certificateHeaderSchema.extend({ rows: z.array(pensionMovementSchema) }).strict(),
    })
    .strict(),
});

export type PensionAccountCertificatesPayload = z.infer<typeof pensionAccountCertificatesKind.payload>;

/** One ledger row the certificates call for. */
export type PensionExpectedRow = {
  period: string;
  /** contribution | insurance_contribution | adjustment */
  kind: string;
  occurred_on: string | null;
  pesos: number;
  cuotas: number;
  /** present: the ledger has it · new: missing (written when applying) · pending: its day is not known yet · conflict */
  state: "present" | "new" | "pending" | "conflict";
  movement_id: number | null;
  detail: string | null;
};

/** `details` of an applied `pension_account.certificates`. */
export type PensionAccountCertificatesApplyDetails = {
  applied: boolean;
  account_id: number;
  rows: PensionExpectedRow[];
  inserted: number;
  /** The fund manager's balance and the ledger's, after the rows this read would write. */
  balance: { stated_cuotas: number; ledger_cuotas_after: number };
  /** Rows waiting on something (a valor cuota not published yet): the read is not complete. */
  pending: number;
  /** Data errors that fail the step and keep anything from being written. */
  problems: string[];
};
