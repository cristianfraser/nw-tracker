/**
 * Read/edit `credit_card_account_config` (cupo, billing cycle) for operational CC masters.
 *
 * The cupo is a row per currency (`credit_card_cupos`, migration 321); the payload lists one entry
 * per currency the card's issuer bills in (primary first), then any other currency on file, a
 * currency without a cupo as null.
 */
import { accountKindSlugForAccountId } from "./accountBucket.js";

import { patchCreditCardBillingConfig } from "./ccBillingBalances.js";
import { db } from "./db.js";
import { loadCreditCardConfigRow, loadCreditCardCupos } from "./cards/config.js";
import { ccIssuerBySlug } from "./ccIssuers.js";
import { ccIssuerSlugForMasterAccount } from "./ccIssuerForAccount.js";
import { currencyMinorDigits } from "./displayUnits.js";

/** A currency code (`currencies.code`). */
export type CcCupoCurrency = string;

/** The currencies a card's cupo is listed in: its issuer's statement currencies, primary first. */
function cupoCurrenciesForCard(accountId: number): string[] {
  const issuer = ccIssuerBySlug(ccIssuerSlugForMasterAccount(accountId));
  if (!issuer) throw new Error(`Account ${accountId}: card issuer has no rules`);
  return [issuer.statement_currencies.primary, ...issuer.statement_currencies.secondary];
}

export type CcCupoEntry = { currency: CcCupoCurrency; value: number | null };

export type CreditCardAccountConfigDto = {
  account_id: number;
  card_last4: string | null;
  billing_cycle_start_day: number;
  /** Raw column value; billing math treats null as 20 (see `loadCreditCardBillingConfig`). */
  billing_cycle_end_day: number | null;
  cupo: CcCupoEntry[];
};

export type CreditCardConfigPatch = {
  billing_cycle_start_day?: number;
  billing_cycle_end_day?: number | null;
  cupo?: CcCupoEntry[];
};

export function isCreditCardAccountId(accountId: number): boolean {
  if (!Number.isFinite(accountId) || accountId <= 0) return false;
  return accountKindSlugForAccountId(accountId) === "credit_card";
}

export function getCreditCardAccountConfig(accountId: number): CreditCardAccountConfigDto {
  if (!isCreditCardAccountId(accountId)) {
    throw new Error(`account ${accountId} is not a credit-card account`);
  }
  // The one config reader: a card master without a row is a routing bug and throws (it used to
  // answer a default 21→20 cycle).
  const row = loadCreditCardConfigRow(accountId);
  return {
    account_id: accountId,
    card_last4: row.card_last4,
    billing_cycle_start_day: row.billing_cycle_start_day,
    billing_cycle_end_day: row.billing_cycle_end_day,
    cupo: cupoEntries(accountId),
  };
}

function cupoEntries(accountId: number): CcCupoEntry[] {
  const stored = loadCreditCardCupos(accountId);
  const currencies = [...new Set([...cupoCurrenciesForCard(accountId), ...stored.keys()])];
  return currencies.map((currency) => ({ currency, value: stored.get(currency) ?? null }));
}

const PATCH_ALLOWED_KEYS = new Set(["billing_cycle_start_day", "billing_cycle_end_day", "cupo"]);

function isCycleDay(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 31;
}

function parseCupoEntries(raw: unknown): CcCupoEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error("cupo must be an array of { currency, value } entries");
  }
  const seen = new Set<CcCupoCurrency>();
  const out: CcCupoEntry[] = [];
  for (const entry of raw) {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("cupo entries must be { currency, value } objects");
    }
    const keys = Object.keys(entry as Record<string, unknown>);
    for (const k of keys) {
      if (k !== "currency" && k !== "value") {
        throw new Error(`unknown cupo entry field: ${k}`);
      }
    }
    const { currency, value } = entry as { currency?: unknown; value?: unknown };
    if (typeof currency !== "string" || !/^[a-z]{3}$/.test(currency)) {
      throw new Error("cupo entry currency must be a lowercase currency code");
    }
    if (seen.has(currency)) {
      throw new Error(`duplicate cupo entry for currency ${currency}`);
    }
    seen.add(currency);
    if (value !== null) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`cupo ${currency} value must be a finite number >= 0 (or null to clear)`);
      }
      const f = 10 ** currencyMinorDigits(currency);
      if (Math.abs(Math.round(value * f) - value * f) > 1e-6) {
        throw new Error(`cupo ${currency} value has more decimals than the currency's smallest coin`);
      }
    }
    out.push({ currency, value: value === null ? null : (value as number) });
  }
  if (out.length === 0) {
    throw new Error("cupo must contain at least one entry");
  }
  return out;
}

/** Fail-fast body validation: allowlisted fields only, sane numbers. Throws on invalid input. */
export function parseCreditCardConfigPatch(body: unknown): CreditCardConfigPatch {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("body must be a JSON object");
  }
  const obj = body as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!PATCH_ALLOWED_KEYS.has(key)) {
      throw new Error(`unknown field: ${key}`);
    }
  }
  const patch: CreditCardConfigPatch = {};
  if ("billing_cycle_start_day" in obj) {
    if (!isCycleDay(obj.billing_cycle_start_day)) {
      throw new Error("billing_cycle_start_day must be an integer between 1 and 31");
    }
    patch.billing_cycle_start_day = obj.billing_cycle_start_day;
  }
  if ("billing_cycle_end_day" in obj) {
    if (obj.billing_cycle_end_day !== null && !isCycleDay(obj.billing_cycle_end_day)) {
      throw new Error("billing_cycle_end_day must be null or an integer between 1 and 31");
    }
    patch.billing_cycle_end_day = obj.billing_cycle_end_day as number | null;
  }
  if ("cupo" in obj) {
    patch.cupo = parseCupoEntries(obj.cupo);
  }
  if (Object.keys(patch).length === 0) {
    throw new Error("no editable fields in body (expected billing_cycle_start_day, billing_cycle_end_day and/or cupo)");
  }
  return patch;
}

const upsertCupoStmt = db.prepare(
  `INSERT INTO credit_card_cupos (account_id, currency, amount) VALUES (?, ?, ?)
   ON CONFLICT(account_id, currency) DO UPDATE SET amount = excluded.amount`
);
const deleteCupoStmt = db.prepare(`DELETE FROM credit_card_cupos WHERE account_id = ? AND currency = ?`);

/** Apply a validated patch. Returns the new config and whether billing-cycle days changed. */
export function applyCreditCardConfigPatch(
  accountId: number,
  patch: CreditCardConfigPatch
): { config: CreditCardAccountConfigDto; billingCycleChanged: boolean } {
  const before = getCreditCardAccountConfig(accountId);

  const billingCycleChanged =
    (patch.billing_cycle_start_day !== undefined &&
      patch.billing_cycle_start_day !== before.billing_cycle_start_day) ||
    (patch.billing_cycle_end_day !== undefined &&
      patch.billing_cycle_end_day !== before.billing_cycle_end_day);

  if (patch.billing_cycle_start_day !== undefined || patch.billing_cycle_end_day !== undefined) {
    patchCreditCardBillingConfig(accountId, {
      billing_cycle_start_day: patch.billing_cycle_start_day,
      billing_cycle_end_day: patch.billing_cycle_end_day,
    });
  }

  if (patch.cupo !== undefined) {
    const allowed = new Set(before.cupo.map((c) => c.currency));
    for (const entry of patch.cupo) {
      if (!allowed.has(entry.currency)) {
        throw new Error(`cupo entry currency ${entry.currency} is not a currency this card bills in`);
      }
    }
    for (const entry of patch.cupo) {
      if (entry.value == null) deleteCupoStmt.run(accountId, entry.currency);
      else upsertCupoStmt.run(accountId, entry.currency, entry.value);
    }
  }

  return { config: getCreditCardAccountConfig(accountId), billingCycleChanged };
}

