/**
 * A card master's issuer, read from its `accounts.import_key` (`credit_card_master|<slug>|<last4>`),
 * and the issuer-level rules that hang off it. Throws for an account that is not a card master of a
 * known issuer: every caller is a card-ledger reader, so any other account is a routing bug.
 */
import { db } from "./db.js";
import { ccIssuerBySlug, ccIssuerSlugFromImportKey, type CcDerivedPayByRule, type CcIssuerSlug } from "./ccIssuers.js";

export function ccIssuerSlugForMasterAccount(accountId: number): CcIssuerSlug {
  const row = db.prepare(`SELECT import_key FROM accounts WHERE id = ?`).get(accountId) as
    | { import_key: string | null }
    | undefined;
  if (!row) throw new Error(`Account ${accountId} does not exist`);
  const slug = ccIssuerSlugFromImportKey(row.import_key);
  if (!slug) {
    throw new Error(
      `Account ${accountId} is not a card master of a known issuer (import_key ${JSON.stringify(row.import_key)})`
    );
  }
  return slug;
}

/** The rule that derives a facturación's pay-by from its close when no statement printed one. */
export function ccDerivedPayByRuleForAccount(accountId: number): CcDerivedPayByRule {
  return ccIssuerBySlug(ccIssuerSlugForMasterAccount(accountId))!.derived_pay_by;
}
