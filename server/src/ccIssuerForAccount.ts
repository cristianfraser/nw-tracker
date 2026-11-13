/**
 * A card master's issuer, read from its config (`credit_card_account_config.issuer`), and the
 * issuer-level rules that hang off it. Throws for an account without a config row or with an
 * issuer the code does not know: every caller is a card-ledger reader, so any other account is a
 * routing bug.
 */
import { db } from "./db.js";
import { dbStateMemo } from "./dbStateMemo.js";
import {
  ccIssuerBySlug,
  requireCcIssuerSlug,
  type CcCuotaSplit,
  type CcDerivedPayByRule,
  type CcIssuerSlug,
} from "./ccIssuers.js";

const stmtIssuer = db.prepare(`SELECT issuer FROM credit_card_account_config WHERE account_id = ?`);

export function ccIssuerSlugForMasterAccount(accountId: number): CcIssuerSlug {
  return dbStateMemo("cc_issuer_for_master", accountId, () => {
    const row = stmtIssuer.get(accountId) as { issuer: string | null } | undefined;
    if (!row) throw new Error(`Account ${accountId} is not a card master (no credit_card_account_config row)`);
    return requireCcIssuerSlug(row.issuer, `Card account ${accountId}`);
  });
}

/** The rule that derives a facturación's pay-by from its close when no statement printed one. */
export function ccDerivedPayByRuleForAccount(accountId: number): CcDerivedPayByRule {
  return ccIssuerBySlug(ccIssuerSlugForMasterAccount(accountId))!.derived_pay_by;
}

/** How the card's issuer splits a plan's principal into the cuotas it has not printed yet. */
export function ccCuotaSplitForAccount(accountId: number): CcCuotaSplit {
  return ccIssuerBySlug(ccIssuerSlugForMasterAccount(accountId))!.cuota_split;
}

/** Where the card is paid with another card in one charge (merchant prefixes; empty: never). */
export function ccFacturadoPaidAtMerchantPrefixesForAccount(accountId: number): readonly string[] {
  return ccIssuerBySlug(ccIssuerSlugForMasterAccount(accountId))!.facturado_paid_at_merchant_prefixes;
}
