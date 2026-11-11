import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

const text = z.string().trim().min(1);
const pesos = z.number().int().nonnegative();
const uf = z.number().nonnegative();
const cuota = z.number().int().positive();

/**
 * One reading of a mortgage lender's customer portal (MetLife Hipotecario's «Centro de pago»):
 * what the portal's own API states about the credit, the cuota due and the cuotas of the last
 * months, as stated — amounts in the currency printed, dates as ISO days. The source ref names the
 * reading (its timestamp): a `read` kind, sent every time the portal is read.
 *
 * `pending` is the cuota the bank asks for now (its quote: minimum and maximum, amortization and
 * interest at the day's UF); its insurance is printed only in UF, on that cuota's `history` row
 * (status `pending`). A `paid` history row carries what the payment posted, insurance in pesos.
 */
export const mortgageLenderInsuranceSchema = z
  .object({
    fire_uf: uf.nullable(),
    life_uf: uf.nullable(),
    other_uf: uf.nullable(),
    fire_pesos: pesos.nullable(),
    life_pesos: pesos.nullable(),
    other_pesos: pesos.nullable(),
  })
  .strict();

export const mortgageLenderPendingSchema = z
  .object({
    cuota,
    /** The lender's period label (YYYYMM), as printed. */
    period: z.string().regex(/^\d{6}$/),
    due_on: z.iso.date(),
    fee_uf: uf,
    fee_pesos: pesos,
    min_uf: uf,
    min_pesos: pesos,
    max_uf: uf,
    max_pesos: pesos,
    amortization_pesos: pesos,
    interest_pesos: pesos,
    default_interest_pesos: pesos,
    collection_fee_pesos: pesos,
  })
  .strict()
  .refine((p) => p.fee_uf > 0 && p.min_uf <= p.max_uf, { message: "a pending cuota's minimum cannot exceed its maximum" });

export const mortgageLenderHistorySchema = z
  .object({
    cuota,
    due_on: z.iso.date(),
    status: z.enum(["paid", "pending", "overdue"]),
    paid_on: z.iso.date().nullable(),
    amortization_pesos: pesos.nullable(),
    extra_amortization_pesos: pesos.nullable(),
    interest_pesos: pesos.nullable(),
    default_interest_pesos: pesos.nullable(),
    collection_fee_pesos: pesos.nullable(),
    total_pesos: pesos.nullable(),
    insurance: mortgageLenderInsuranceSchema,
  })
  .strict()
  .refine((h) => (h.status === "paid") === (h.paid_on != null), { message: "a paid cuota has a payment day, an unpaid one none" })
  .refine(
    (h) => {
      if (h.status !== "paid") return true;
      const parts = [h.amortization_pesos, h.extra_amortization_pesos ?? 0, h.interest_pesos, h.default_interest_pesos ?? 0, h.collection_fee_pesos ?? 0, h.insurance.fire_pesos, h.insurance.life_pesos, h.insurance.other_pesos ?? 0];
      if (parts.some((x) => x == null) || h.total_pesos == null) return false;
      const sum = (parts as number[]).reduce((a, b) => a + b, 0);
      return Math.abs(sum - h.total_pesos) <= 1;
    },
    { message: "a paid cuota's parts must add up to its total (to the peso)" }
  );

export const mortgageLenderStatementKind = defineIngestKind({
  kind: "mortgage.lender_statement",
  schema_version: 1,
  description: "One reading of a mortgage lender's portal: the credit, the cuota due and recent cuotas.",
  ref: "read",
  payload: z
    .object({
      /** Lender slug («metlife»). */
      lender: z.string().regex(/^[a-z][a-z0-9_]*$/),
      credit_number: text,
      read_at: z.iso.datetime({ offset: true }),
      credit: z
        .object({
          balance_uf: uf,
          original_debt_uf: uf.nullable(),
          total_cuotas: cuota.nullable(),
          last_paid_cuota: cuota.nullable(),
          last_paid_on: z.iso.date().nullable(),
          last_paid_pesos: pesos.nullable(),
        })
        .strict(),
      pending: z.array(mortgageLenderPendingSchema),
      history: z.array(mortgageLenderHistorySchema),
    })
    .strict()
    .superRefine((p, ctx) => {
      for (const due of p.pending) {
        // The quote's pesos are its parts at one UF: amortization + interest + charges + insurance UF × that UF.
        const ins = p.history.find((h) => h.cuota === due.cuota && h.status !== "paid")?.insurance;
        if (!ins) {
          ctx.addIssue({ code: "custom", message: `pending cuota ${due.cuota} has no history row stating its insurance` });
          continue;
        }
        const insUf = (ins.fire_uf ?? 0) + (ins.life_uf ?? 0) + (ins.other_uf ?? 0);
        const ufValue = due.fee_pesos / due.fee_uf;
        const expected = due.amortization_pesos + due.interest_pesos + due.default_interest_pesos + due.collection_fee_pesos + insUf * ufValue;
        if (Math.abs(expected - due.fee_pesos) > 2) {
          ctx.addIssue({ code: "custom", message: `pending cuota ${due.cuota}: parts + insurance at the quote's UF give ${expected.toFixed(0)}, not ${due.fee_pesos}` });
        }
      }
    }),
});

export type MortgageLenderStatementPayload = z.infer<typeof mortgageLenderStatementKind.payload>;

/** `details` of an applied `mortgage.lender_statement`. */
export type MortgageLenderStatementApplyDetails = {
  /** The cuota quoted now and whether this reading stored a new quote row for it. */
  quote: { cuota: number; due_on: string; stored: boolean; first_seen_at: string } | null;
  /** Paid cuotas: written to the ledger now, already there and equal, or waiting (e.g. no balance after it). */
  paid: { cuota: number; outcome: "written" | "matches" | "waiting"; detail: string }[];
};
