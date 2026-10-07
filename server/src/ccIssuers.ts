/**
 * Card issuers: each is a credit-card group (`credit_card_groups`, its Pasivos page) holding the
 * card masters whose `accounts.import_key` starts with `credit_card_master|<slug>|`. A leaf module
 * so the tree seed and the aggregation cache read one list.
 */
export const CC_ISSUERS = [
  { slug: "santander", label: "Santander", sort_order: 0, label_i18n_key: "creditCardGroup.santander" },
  { slug: "bci", label: "BCI", sort_order: 10, label_i18n_key: "creditCardGroup.bci" },
  { slug: "cmr", label: "CMR Falabella", sort_order: 20, label_i18n_key: "creditCardGroup.cmr" },
] as const;

export type CcIssuerSlug = (typeof CC_ISSUERS)[number]["slug"];

export const CC_ISSUER_SLUGS: readonly CcIssuerSlug[] = CC_ISSUERS.map((i) => i.slug);

export function ccMasterImportKeyPrefix(slug: CcIssuerSlug): string {
  return `credit_card_master|${slug}|`;
}
