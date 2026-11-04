/**
 * Card issuers: a card master's issuer is `credit_card_account_config.issuer` (one of these slugs;
 * its `accounts.import_key`, `credit_card_master|<slug>|<last4>`, is the card's identity only). An
 * issuer carries the rules a statement does not state; its `sort_order` orders the cards under
 * Pasivos › tarjeta de crédito. A leaf module.
 */
/**
 * How an issuer sets a facturación's PAGAR HASTA when no statement has printed it yet (an open,
 * provisional or projected month) — backtracked over every statement on file (2026-10-26):
 * BCI prints the 10th of the month after the close as it falls, weekends included (14 of 14);
 * Santander lands on the 8th–10th with no exact rule from the close, and «the 10th, moved back
 * to the previous Chile business day» is the closest (16 of 23 on the current card, the other
 * seven one day earlier than predicted, never later); CMR printed close + 16 days (the 30th).
 */
export type CcDerivedPayByRule =
  | { kind: "next_month_day"; day: number; prior_business_day: boolean }
  | { kind: "close_plus_days"; days: number };

type CcIssuerDef = {
  slug: string;
  sort_order: number;
  derived_pay_by: CcDerivedPayByRule;
};

export const CC_ISSUERS = [
  {
    slug: "santander",
    sort_order: 0,
    derived_pay_by: { kind: "next_month_day", day: 10, prior_business_day: true },
  },
  {
    slug: "bci",
    sort_order: 10,
    derived_pay_by: { kind: "next_month_day", day: 10, prior_business_day: false },
  },
  {
    slug: "cmr",
    sort_order: 20,
    derived_pay_by: { kind: "close_plus_days", days: 16 },
  },
] as const satisfies readonly CcIssuerDef[];

export type CcIssuerSlug = (typeof CC_ISSUERS)[number]["slug"];

export const CC_ISSUER_SLUGS: readonly CcIssuerSlug[] = CC_ISSUERS.map((i) => i.slug);

export function ccMasterImportKeyPrefix(slug: CcIssuerSlug): string {
  return `credit_card_master|${slug}|`;
}

export function ccIssuerBySlug(slug: string): (typeof CC_ISSUERS)[number] | null {
  return CC_ISSUERS.find((i) => i.slug === slug) ?? null;
}

/** A stored issuer: one of `CC_ISSUERS`, else it throws (an issuer the code has no rules for). */
export function requireCcIssuerSlug(value: string | null | undefined, context: string): CcIssuerSlug {
  const issuer = value != null ? ccIssuerBySlug(value) : null;
  if (!issuer) throw new Error(`${context}: unknown card issuer ${JSON.stringify(value ?? null)}`);
  return issuer.slug;
}
