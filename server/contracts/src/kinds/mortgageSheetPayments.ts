import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const clp = z.number().int();
const uf = z.number().finite();

/**
 * One row of the mortgage sheet: a capital event of the loan — the pie, a prepago, or a cuota the
 * bank has posted and the user has paid. Figures as the sheet holds them: pesos whole, UF to 4–5
 * decimals, `uf_day` the UF the row was valued at (the pay day's UF).
 */
export const mortgageSheetPaymentRowSchema = z
  .object({
    kind: z.enum(["pie", "prepago", "cuota"]),
    /** The sheet's own label: «pie», «prepago 2», or the cuota number («32»). */
    label: z.string().trim().min(1),
    paid_on: ymd,
    uf_day: z.number().positive(),
    pago_clp: clp.positive(),
    pago_uf: uf.positive(),
    interes_clp: clp.nullable(),
    interes_uf: uf.nullable(),
    /** The bank's posted cuota mínima / máxima, in UF (cuotas only). */
    min_uf: uf.nullable(),
    max_uf: uf.nullable(),
    incendio_clp: clp.nullable(),
    incendio_uf: uf.nullable(),
    desgravamen_clp: clp.nullable(),
    desgravamen_uf: uf.nullable(),
    amortizacion_clp: clp.nullable(),
    amortizacion_uf: uf.nullable(),
    amortizacion_ext_clp: clp.nullable(),
    amortizacion_ext_uf: uf.nullable(),
    /** Crédito restante after this row, in UF — the bank's posted balance. */
    credito_restante_uf: uf.nonnegative(),
    valor_vivienda_uf: uf.nullable(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const label = `row ${r.label}`;
    if (Math.abs(Math.round(r.pago_uf * r.uf_day) - r.pago_clp) > 1) {
      ctx.addIssue({ code: "custom", message: `${label}: pago ${r.pago_clp} is not pago UF × uf día (${r.pago_uf} × ${r.uf_day})` });
    }
    if (r.kind === "cuota") {
      if (!/^\d+$/.test(r.label)) ctx.addIssue({ code: "custom", message: `${label}: a cuota's label is its number` });
      for (const k of ["interes_clp", "min_uf", "max_uf", "incendio_clp", "desgravamen_clp", "amortizacion_clp", "amortizacion_ext_clp"] as const) {
        if (r[k] == null) ctx.addIssue({ code: "custom", message: `${label}: ${k} is required on a cuota` });
      }
      if (r.min_uf != null && r.max_uf != null && r.min_uf > r.max_uf) {
        ctx.addIssue({ code: "custom", message: `${label}: min UF ${r.min_uf} above máx UF ${r.max_uf}` });
      }
      if (r.min_uf != null && r.pago_uf + 1e-4 < r.min_uf) {
        ctx.addIssue({ code: "custom", message: `${label}: pago ${r.pago_uf} UF below the cuota mínima ${r.min_uf} UF` });
      }
      // Whether interés + seguros + amortización + ext add up to the pago is NOT checked here: an
      // old row of the sheet may carry its own rounding (cuota 12 is 772 pesos short), and such
      // rows are only cross-checked field by field. A row the server writes goes through the
      // payment compute, which refuses components that do not add up to the pago.
    } else if (r.kind === "prepago" && !/^prepago \d+$/.test(r.label)) {
      ctx.addIssue({ code: "custom", message: `${label}: a prepago's label is «prepago N»` });
    } else if (r.kind === "pie" && r.label !== "pie") {
      ctx.addIssue({ code: "custom", message: `${label}: the pie's label is «pie»` });
    }
  });

export type MortgageSheetPaymentRow = z.infer<typeof mortgageSheetPaymentRowSchema>;

/**
 * The mortgage sheet the user keeps by hand (a Numbers table, read in place): every pie / prepago
 * row and every cuota whose bank figures are typed in. The server cross-checks the rows already in
 * its ledger (a difference fails the import — the two are records of the same payment), writes
 * the posted cuotas it does not hold yet, and records the document so the same file answers
 * `duplicate`. Only the sheet's own figures travel; nothing is derived in the feeder.
 */
export const mortgageSheetPaymentsKind = defineIngestKind({
  kind: "mortgage.sheet_payments",
  schema_version: 1,
  description: "The user's mortgage payment sheet: pie, prepagos and the posted cuotas, as typed.",
  payload: z
    .object({
      /** False: report what the import would do, write nothing. */
      apply: z.boolean(),
      document: z
        .object({
          name: z.string().trim().min(1),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
          size: z.number().int().positive(),
          modified_at: z.iso.datetime(),
        })
        .strict(),
      sheet: z.string().trim().min(1),
      table: z.string().trim().min(1),
      rows: z.array(mortgageSheetPaymentRowSchema).min(1),
      /** Cuota numbers the sheet projects but has not posted (left out), for the report. */
      projected: z.array(z.string()),
      /**
       * Differences the user has declared and accepts (`accepted_differences` in the config): a
       * stored row's field the sheet states otherwise, with the reason. Reported, never a conflict.
       * Example: prepago 1's crédito restante — the bank processed the prepago before cuota 9
       * although the cuota was paid first, and the sheet follows the bank's order.
       */
      accepted: z
        .array(z.object({ label: z.string().trim().min(1), field: z.string().trim().min(1), reason: z.string().trim().min(1) }).strict())
        .default([]),
    })
    .strict()
    .superRefine((p, ctx) => {
      const seen = new Set<string>();
      let lastDate = "";
      for (const r of p.rows) {
        if (seen.has(r.label)) ctx.addIssue({ code: "custom", message: `row ${r.label} listed twice` });
        seen.add(r.label);
        if (r.paid_on < lastDate) ctx.addIssue({ code: "custom", message: `row ${r.label} (${r.paid_on}) is out of date order` });
        lastDate = r.paid_on;
      }
    }),
});

export type MortgageSheetPaymentsPayload = z.infer<typeof mortgageSheetPaymentsKind.payload>;

export type MortgageSheetRowOutcome = {
  label: string;
  paid_on: string;
  /** `written`: the ledger rows were written (or would be, without `apply`); `checked`: already in
   *  the ledger and agreeing; `not_due`: posted with a future date, written once that day comes. */
  status: "written" | "checked" | "not_due";
  /** Columns the import filled on a stored row (`max_uf` the ledger lacked). */
  filled: string[];
  mortgage_movement_id: number | null;
};

/** `details` of a `mortgage.sheet_payments` result (a conflict carries `drift`). */
export type MortgageSheetPaymentsApplyDetails = {
  document: string;
  applied: boolean;
  rows: MortgageSheetRowOutcome[];
  projected: string[];
  /** Stored rows whose figures differ from the sheet's: nothing was written. */
  drift: { label: string; field: string; sheet: number | string | null; ledger: number | string | null }[];
  /** Declared differences met on this import (`accepted` in the payload), with both figures. */
  accepted: { label: string; field: string; sheet: number | string | null; ledger: number | string | null; reason: string }[];
};
