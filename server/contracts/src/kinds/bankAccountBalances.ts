import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

export const bankAccountBalanceSchema = z
  .object({
    /** The bank's number for the account (Santander: the contract number of its product summary). */
    number: z.string().regex(/^\d+$/),
    /** `checking`: a cuenta corriente (peso or dollar); `demand_deposit`: a cuenta vista. */
    product: z.enum(["checking", "demand_deposit"]),
    currency: z.enum(["clp", "usd"]),
    /** The balance as the bank states it: pesos whole, dollars to the cent. */
    balance: z.number().refine((n) => Number.isFinite(n) && Math.round(n * 100) === n * 100, {
      message: "balance has at most two decimals",
    }),
    /** The bank's own label and state, as printed (provenance). */
    label: z.string().trim().min(1),
    status: z.string().trim().min(1),
  })
  .strict();

export type BankAccountBalance = z.infer<typeof bankAccountBalanceSchema>;

/**
 * The balances a bank states for its client's deposit accounts at one moment (Santander: the
 * landing page's product summary, read at each login). A statement of fact, not movements: the
 * server records it and checks the accounts it knows against their ledgers.
 */
export const bankAccountBalancesKind = defineIngestKind({
  kind: "bank_account.balances",
  schema_version: 1,
  description: "The balances a bank states for its client's deposit accounts at one moment.",
  payload: z
    .object({
      issuer: z.string().regex(/^[a-z][a-z0-9_]*$/),
      observed_at: z.iso.datetime({ offset: true }),
      accounts: z.array(bankAccountBalanceSchema).min(1),
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

export type BankAccountBalancesPayload = z.infer<typeof bankAccountBalancesKind.payload>;

/** `details` of an applied `bank_account.balances` result. */
export type BankAccountBalancesApplyDetails = {
  recorded: number;
  /** Accounts the server checks (their number is declared on one of its accounts). */
  known: { account_id: number; number: string; currency: "clp" | "usd"; balance: number }[];
  /** Numbers no account declares — recorded, not checked. */
  unknown: { number: string; currency: "clp" | "usd"; label: string }[];
};
