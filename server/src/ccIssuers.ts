/**
 * Card issuers: each is a credit-card group (`credit_card_groups`, its Pasivos page) holding the
 * card masters whose `accounts.import_key` starts with `credit_card_master|<slug>|`. A leaf module
 * so the tree seed and the aggregation cache read one list.
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
  label: string;
  sort_order: number;
  label_i18n_key: string;
  derived_pay_by: CcDerivedPayByRule;
};

export const CC_ISSUERS = [
  {
    slug: "santander",
    label: "Santander",
    sort_order: 0,
    label_i18n_key: "creditCardGroup.santander",
    derived_pay_by: { kind: "next_month_day", day: 10, prior_business_day: true },
  },
  {
    slug: "bci",
    label: "BCI",
    sort_order: 10,
    label_i18n_key: "creditCardGroup.bci",
    derived_pay_by: { kind: "next_month_day", day: 10, prior_business_day: false },
  },
  {
    slug: "cmr",
    label: "CMR Falabella",
    sort_order: 20,
    label_i18n_key: "creditCardGroup.cmr",
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

/** The issuer slug of a card master's `import_key` (`credit_card_master|<slug>|<last4>`), else null. */
export function ccIssuerSlugFromImportKey(importKey: string | null | undefined): CcIssuerSlug | null {
  const m = /^credit_card_master\|([^|]+)\|/.exec(String(importKey ?? ""));
  if (!m) return null;
  const issuer = ccIssuerBySlug(m[1]!);
  return issuer ? issuer.slug : null;
}
