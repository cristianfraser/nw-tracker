import type { NavTreeNodeDto } from "./types";

export type LiabilitiesPageKind = "pasivos_root" | "credit_card" | "mortgage";

/** Which specialized pasivos layout applies to this nav node. */
export function resolveLiabilitiesPageKind(navNode: NavTreeNodeDto): LiabilitiesPageKind {
  if (navNode.slug === "liabilities_mortgage" || navNode.api_subgroup === "mortgage") {
    return "mortgage";
  }
  if (
    navNode.slug === "liabilities_credit_card" ||
    navNode.asset_group_slug === "credit_cards" ||
    navNode.api_subgroup === "credit_card"
  ) {
    return "credit_card";
  }
  return "pasivos_root";
}
