/**
 * Who stands behind an account, and in which country — the one place a tax reader asks where an
 * income was paid from (docs/demo-app-features-plan.md §5, review item 13). Read as data:
 *
 * - a **broker** is the `broker_cash` role (`<broker>|<currency>`, `accountRoles.ts`); its country
 *   is {@link FOREIGN_BROKER_COUNTRY}'s entry, and a broker not listed there is domiciled in Chile
 *   (the brokers the app has always read as domestic: Fintual, Racional, the demo's broker);
 * - a **bank** is a `bank_account_numbers` row (issuer + currency); its country is the US for an
 *   issuer in {@link US_BANK_ISSUERS}, Chile for any other.
 *
 * An account can stand behind several (a numbered account at one bank, a broker's cash). Never a
 * name match. A tax return decides what a payer's country means for it (the F22 reads a US payer as
 * foreign-source; the 1040 reads a Chilean one so).
 */
import { db } from "../db.js";

/** ISO 3166-1 alpha-2 country of a payer. */
export type TaxCountry = "CL" | "US";

/** The fictional Texas bank of the demo person (its checking and savings accounts). */
export const DEMO_US_BANK_ISSUER = "demo_bank_texas";

/** `bank_account_numbers.issuer` values that are US banks. */
export const US_BANK_ISSUERS: readonly string[] = [DEMO_US_BANK_ISSUER];

/** Brokers domiciled abroad, by `broker_cash` broker slug. */
export const FOREIGN_BROKER_COUNTRY: Readonly<Record<string, TaxCountry>> = { ibkr: "US" };

/** The brokers {@link FOREIGN_BROKER_COUNTRY} lists: what the F22 has always called its foreign brokers. */
export const FOREIGN_BROKERS: readonly string[] = Object.keys(FOREIGN_BROKER_COUNTRY);

export type AccountPayer =
  | { kind: "broker"; broker: string; currency: string; country: TaxCountry }
  | { kind: "bank"; issuer: string; currency: string; country: TaxCountry };

export function brokerCountry(broker: string): TaxCountry {
  return FOREIGN_BROKER_COUNTRY[broker] ?? "CL";
}

export function bankCountry(issuer: string): TaxCountry {
  return US_BANK_ISSUERS.includes(issuer) ? "US" : "CL";
}

/**
 * Every account's payers, read once: brokers (by role, in role order) then banks (by issuer,
 * currency). An account with neither is absent.
 */
export function loadAccountPayers(): Map<number, AccountPayer[]> {
  const out = new Map<number, AccountPayer[]>();
  const add = (id: number, p: AccountPayer) => out.set(id, [...(out.get(id) ?? []), p]);
  const roles = db
    .prepare(`SELECT account_id, param FROM account_roles WHERE role = 'broker_cash' ORDER BY account_id, param`)
    .all() as { account_id: number; param: string }[];
  for (const r of roles) {
    const bar = r.param.indexOf("|");
    if (bar <= 0) throw new Error(`account role broker_cash of account ${r.account_id}: param «${r.param}» is not <broker>|<currency>`);
    const broker = r.param.slice(0, bar);
    add(r.account_id, { kind: "broker", broker, currency: r.param.slice(bar + 1), country: brokerCountry(broker) });
  }
  const banks = db
    .prepare(`SELECT DISTINCT account_id, issuer, currency FROM bank_account_numbers ORDER BY account_id, issuer, currency`)
    .all() as { account_id: number; issuer: string; currency: string }[];
  for (const b of banks) add(b.account_id, { kind: "bank", issuer: b.issuer, currency: b.currency, country: bankCountry(b.issuer) });
  return out;
}

/** A US bank's dollar account (line 2b of the 1040, `usBankAccounts.ts`). */
export function isUsBankDollarPayer(p: AccountPayer): boolean {
  return p.kind === "bank" && p.country === "US" && p.currency === "usd";
}
