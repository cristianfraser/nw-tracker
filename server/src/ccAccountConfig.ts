/**
 * Read/edit `credit_card_account_config` (cupo, billing cycle) for operational CC masters.
 *
 * DB columns stay per-currency (`cupo_clp` / `cupo_usd`, see the deferred value+currency
 * refactor in AGENTS.md); the API payload uses the newer single value+currency shape
 * (`cupo: [{ currency, value }]`).
 */
import { accountKindSlugForAccountId } from "./accountBucket.js";
import { invalidateCcBillingDetail } from "./aggregationCache.js";
import { patchCreditCardBillingConfig } from "./ccBillingBalances.js";
import { db } from "./db.js";

export type CcCupoCurrency = "clp" | "usd";

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

const configRowStmt = db.prepare(
  `SELECT card_last4, billing_cycle_start_day, billing_cycle_end_day, cupo_clp, cupo_usd
   FROM credit_card_account_config WHERE account_id = ?`
);

type ConfigRow = {
  card_last4: string | null;
  billing_cycle_start_day: number;
  billing_cycle_end_day: number | null;
  cupo_clp: number | null;
  cupo_usd: number | null;
};

export function getCreditCardAccountConfig(accountId: number): CreditCardAccountConfigDto {
  if (!isCreditCardAccountId(accountId)) {
    throw new Error(`account ${accountId} is not a credit-card account`);
  }
  const row = configRowStmt.get(accountId) as ConfigRow | undefined;
  return {
    account_id: accountId,
    card_last4: row?.card_last4 ?? null,
    billing_cycle_start_day: row?.billing_cycle_start_day ?? 21,
    billing_cycle_end_day: row ? row.billing_cycle_end_day : null,
    cupo: [
      { currency: "clp", value: row?.cupo_clp ?? null },
      { currency: "usd", value: row?.cupo_usd ?? null },
    ],
  };
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
    if (currency !== "clp" && currency !== "usd") {
      throw new Error("cupo entry currency must be 'clp' or 'usd'");
    }
    if (seen.has(currency)) {
      throw new Error(`duplicate cupo entry for currency ${currency}`);
    }
    seen.add(currency);
    if (value !== null) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`cupo ${currency} value must be a finite number >= 0 (or null to clear)`);
      }
      if (currency === "clp" && !Number.isInteger(value)) {
        throw new Error("cupo clp value must be an integer amount of pesos");
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
  `INSERT INTO credit_card_account_config (account_id, cupo_clp, cupo_usd)
   VALUES (@account_id, @cupo_clp, @cupo_usd)
   ON CONFLICT(account_id) DO UPDATE SET
     cupo_clp = excluded.cupo_clp,
     cupo_usd = excluded.cupo_usd`
);

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
    const next = new Map<CcCupoCurrency, number | null>([
      ["clp", before.cupo.find((c) => c.currency === "clp")?.value ?? null],
      ["usd", before.cupo.find((c) => c.currency === "usd")?.value ?? null],
    ]);
    for (const entry of patch.cupo) next.set(entry.currency, entry.value);
    upsertCupoStmt.run({
      account_id: accountId,
      cupo_clp: next.get("clp"),
      cupo_usd: next.get("usd"),
    });
    invalidateCcBillingDetail(accountId);
  }

  return { config: getCreditCardAccountConfig(accountId), billingCycleChanged };
}

