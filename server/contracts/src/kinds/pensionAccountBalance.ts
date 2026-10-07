import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";
import { pensionRecentMovementSchema, type PensionAccountCertificatesApplyDetails } from "./pensionAccountCertificates.js";

/**
 * A pension account's balance as the fund manager's home page states it — read every night.
 * The server compares the stated cuotas with the account's ledger: equal, it checks the stated
 * pesos against the app's value; different, it asks for the certificates
 * (`pension_account.certificates`), which say what moved.
 */
export const pensionAccountBalanceKind = defineIngestKind({
  kind: "pension_account.balance",
  schema_version: 1,
  description: "A pension account's stated balance and recent movements, from its home page.",
  payload: z
    .object({
      provider: z.enum(["afp_uno"]),
      product: z.enum(["mandatory"]),
      fund: z.string().regex(/^[A-E]$/),
      read_at: z.iso.datetime({ offset: true }),
      balance: z
        .object({ cuotas: z.number().nonnegative(), valor_cuota: z.number().positive(), pesos: z.number().int().nonnegative() })
        .strict(),
      recent_movements: z.array(pensionRecentMovementSchema),
    })
    .strict(),
});

export type PensionAccountBalancePayload = z.infer<typeof pensionAccountBalanceKind.payload>;

/** `details` of an applied `pension_account.balance`. */
export type PensionAccountBalanceApplyDetails = {
  account_id: number;
  stated_cuotas: number;
  ledger_cuotas: number;
  /** The stated cuotas differ from the ledger's: something moved — read the certificates. */
  certificates_needed: boolean;
  /** Null when the cuotas differ (the certificates come first). */
  value_check: PensionAccountCertificatesApplyDetails["value_check"] | null;
  /** Data errors that fail the step. */
  problems: string[];
};
