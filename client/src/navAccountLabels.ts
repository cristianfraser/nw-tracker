import type { AccountListRow } from "./types";

export function normalizeHierarchyCompare(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

/** Omit a redundant intermediate group when one account matches the group label. */
export function hideRedundantGroupRow(
  groupRowName: string,
  accounts: AccountListRow[],
  accountLabel: (a: AccountListRow) => string
): boolean {
  return (
    accounts.length === 1 &&
    normalizeHierarchyCompare(groupRowName) === normalizeHierarchyCompare(accountLabel(accounts[0]!))
  );
}

export function brokerageAccountNavLabel(a: AccountListRow): string {
  switch (a.category_slug) {
    case "fintual_risky_norris":
      return "risky norris";
    case "spy":
      return "spy";
    case "vea":
      return "vea";
    case "bitcoin":
      return "bitcoin";
    case "eth":
      return "ether";
    default:
      return a.name;
  }
}

export function retirementAccountNavLabel(a: AccountListRow): string {
  if (a.category_slug === "apv") {
    if (a.notes === "import:excel|key=apv_a_principal") return "apv-a-principal";
    if (a.notes === "import:excel|key=apv_a") return "apv-a-fintual";
    if (a.notes === "import:excel|key=apv_b") return "apv-b-fintual";
  }
  return a.name;
}

const LIABILITY_CATEGORY_LABELS: Record<string, string> = {
  credit_card: "credit card",
  mortgage: "mortgage",
};

export function liabilityCategoryNavLabel(slug: string): string {
  return LIABILITY_CATEGORY_LABELS[slug] ?? slug.replace(/_/g, " ");
}

export function assetAccountSidebarLabel(a: AccountListRow): string {
  if (a.group_slug === "real_estate") return a.name.trim().toLowerCase();
  return a.name;
}
