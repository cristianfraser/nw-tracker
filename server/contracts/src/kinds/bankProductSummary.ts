import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";
import { bankAccountBalanceSchema } from "./bankAccountBalances.js";
import { issuerCardBalancesSchema } from "./cardUnbilledMovements.js";

/**
 * What a bank's landing page states about every product of its client at one moment — the card
 * cupos and the deposit-account balances, nothing else (Santander: the product summary every login
 * gets). The hourly balance poll sends it before reading any movement: the server records it,
 * judges each product against the app, and answers which movement listings the session must read
 * (`fetch`) — only the products that disagree.
 */
export const BANK_PRODUCT_SUMMARY_FETCH_STEPS = ["card-movements", "checking-movements", "checking-usd-movements"] as const;
export type BankProductSummaryFetchStep = (typeof BANK_PRODUCT_SUMMARY_FETCH_STEPS)[number];

export const bankProductSummaryKind = defineIngestKind({
  kind: "bank.product_summary",
  schema_version: 1,
  description: "The card cupos and deposit-account balances a bank states at one moment.",
  payload: z
    .object({
      issuer: z.string().regex(/^[a-z][a-z0-9_]*$/),
      observed_at: z.iso.datetime({ offset: true }),
      cards: issuerCardBalancesSchema,
      accounts: z.array(bankAccountBalanceSchema),
    })
    .strict()
    .superRefine((p, ctx) => {
      const seen = new Set<string>();
      for (const a of p.accounts) {
        const key = `${a.number}|${a.currency}`;
        if (seen.has(key)) ctx.addIssue({ code: "custom", message: `account ${key} listed twice` });
        seen.add(key);
      }
    }),
});

export type BankProductSummaryPayload = z.infer<typeof bankProductSummaryKind.payload>;

/** `details` of an applied `bank.product_summary` result. */
export type BankProductSummaryApplyDetails = {
  /** The movement listings the session should read now (empty: everything agrees). */
  fetch: BankProductSummaryFetchStep[];
  /** One line per product that disagrees, and why it is fetched (or not). */
  mismatches: string[];
};
