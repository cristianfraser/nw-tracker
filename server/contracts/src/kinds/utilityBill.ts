import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

const text = z.string().trim().min(1);

/**
 * What a bill is for; the server files it under the matching real-estate bill kind. `hoa` is a
 * building's monthly common-expenses statement (gastos comunes) for one unit.
 */
export const UTILITY_SERVICES = ["electricity", "gas", "water", "internet", "hoa"] as const;
export type UtilityService = (typeof UTILITY_SERVICES)[number];

export const utilityBillSchema = z
  .object({
    /** Who billed («enel», «metrogas»…): a slug, never a display name. */
    provider: z.string().regex(/^[a-z][a-z0-9_]*$/),
    service: z.enum(UTILITY_SERVICES),
    /** The provider's number for the supply (N° cliente; a building's unit number), as printed. */
    service_account: text,
    /**
     * The bill's own number (N° boleta), as printed: with the provider, the bill's identity. A
     * statement that prints none is numbered `<service_account>-<YYYY-MM>` (its unit and month).
     */
    bill_number: text,
    issued_on: z.iso.date(),
    /** Pesos to pay, as printed. */
    amount: z.number().int().nonnegative(),
    due_on: z.iso.date(),
    /** The consumption period the bill charges, when the bill (or its predecessor) states it. */
    period_from: z.iso.date().nullable(),
    period_to: z.iso.date().nullable(),
    /** Electricity consumed in the period, as printed; null when the bill states none. */
    kwh: z.number().nonnegative().nullable(),
    /** Gas (or water) consumed in the period, as printed; null when the bill states none. */
    m3: z.number().nonnegative().nullable(),
    /** True when the provider estimated the reading, false when it read the meter, null when not printed. */
    estimated_reading: z.boolean().nullable(),
    /** The mail (or document) the bill was read from: provenance, not identity. */
    message_id: text,
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.kwh != null && b.service !== "electricity") {
      ctx.addIssue({ code: "custom", message: `${b.provider} ${b.bill_number}: kwh on a ${b.service} bill` });
    }
    if (b.m3 != null && b.service !== "gas" && b.service !== "water") {
      ctx.addIssue({ code: "custom", message: `${b.provider} ${b.bill_number}: m3 on a ${b.service} bill` });
    }
    if (b.period_from != null && b.period_to != null && b.period_from > b.period_to) {
      ctx.addIssue({ code: "custom", message: `${b.provider} ${b.bill_number}: period ends before it starts` });
    }
    if (b.due_on < b.issued_on) {
      ctx.addIssue({ code: "custom", message: `${b.provider} ${b.bill_number}: due before it was issued` });
    }
  });

export type UtilityBill = z.infer<typeof utilityBillSchema>;

/**
 * Utility bills (electricity, gas, water, internet) for a supply: what each charged, when it is
 * due, the period and the consumption it states. Decoded by the feeder from the provider's bill
 * mail or document; the server files each under the place the supply belongs to, paired with the
 * card or checking charge that paid it.
 */
export const utilityBillKind = defineIngestKind({
  kind: "utility.bill",
  schema_version: 1,
  description: "Utility bills (electricity, gas, water, internet) with their consumption.",
  payload: z
    .object({ bills: z.array(utilityBillSchema) })
    .strict()
    .superRefine((p, ctx) => {
      const seen = new Set<string>();
      for (const b of p.bills) {
        const key = `${b.provider}|${b.bill_number}`;
        if (seen.has(key)) ctx.addIssue({ code: "custom", message: `bill ${key} listed twice` });
        seen.add(key);
      }
    }),
});

export type UtilityBillPayload = z.infer<typeof utilityBillKind.payload>;

/** Why a stored bill wrote nothing this run. */
export type UtilityBillOutcome =
  /** A bill row was created from its charge, with the consumption. */
  | "created"
  /** The charge was already filed under a bill by hand; the consumption was filled in. */
  | "filled"
  /** The charge was already filed under a bill that carries this consumption already. */
  | "already_filed"
  /** No mapping from the provider's account to a place. */
  | "unmapped"
  /** No charge of the bill's pesos yet. */
  | "waiting"
  /** Still no charge, past due + the grace days. */
  | "overdue"
  /** Several charges fit; nothing written. */
  | "ambiguous"
  /** A bill of zero pesos: nothing was charged. */
  | "nothing_to_pay"
  /** The bill disagrees with what the page holds; nothing written. */
  | "conflict";

/** `details` of a `utility.bill` result. */
export type UtilityBillApplyDetails = {
  received: number;
  new_bills: number;
  /**
   * Payments to a building's administration (gastos comunes of a place that receives `hoa` bills)
   * no bill accounts for, older than the grace days: the statement for their month never arrived.
   * Nothing is written for them.
   */
  unbilled_hoa_payments: { place: string; purchase_key: string; day: string; amount: number; merchant: string | null }[];
  /** One row per stored bill still being followed (new, or not settled before). */
  bills: {
    provider: string;
    bill_number: string;
    issued_on: string;
    amount: number;
    outcome: UtilityBillOutcome;
    /** The real-estate place (expense account slug), when mapped. */
    place: string | null;
    /** The bill's month on the page (`YYYY-MM`), when one is known. */
    bill_month: string | null;
    expense_entry_id: number | null;
    purchase_key: string | null;
    message: string | null;
  }[];
};
