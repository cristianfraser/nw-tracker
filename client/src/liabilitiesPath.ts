/** URL segment → liability category slug (`accounts.category_slug`). */
export type LiabilitiesCategorySlug = "credit_card" | "mortgage";

const SEGMENT_TO_CATEGORY: Record<string, LiabilitiesCategorySlug> = {
  "credit-card": "credit_card",
  mortgage: "mortgage",
};

const CATEGORY_TO_SEGMENT: Record<LiabilitiesCategorySlug, string> = {
  credit_card: "credit-card",
  mortgage: "mortgage",
};

/** `undefined` = all Pasivos; `null` = invalid path segment. */
export function parseLiabilitiesSubgroupParam(
  segment: string | undefined
): LiabilitiesCategorySlug | undefined | null {
  if (segment == null || segment === "") return undefined;
  const cat = SEGMENT_TO_CATEGORY[segment];
  return cat ?? null;
}

export function liabilitiesSubgroupPath(category: LiabilitiesCategorySlug): string {
  return `/liabilities/${CATEGORY_TO_SEGMENT[category]}`;
}
