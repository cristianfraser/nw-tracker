import i18n from "./i18n";
import type { AccountListRow } from "./types";

const LIABILITY_CATEGORY_KEYS: Record<string, string> = {
  credit_card: "liabilities.creditCard",
  mortgage: "liabilities.mortgage",
};

export function liabilityCategoryNavLabel(slug: string): string {
  const k = LIABILITY_CATEGORY_KEYS[slug];
  return k ? i18n.t(k) : slug.replace(/_/g, " ");
}

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
      if (a.notes?.startsWith("import:fintual|cert|key=")) return a.name;
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
    if (a.notes === "import:fintual|cert|key=apv_a") return a.name;
    if (a.notes === "import:fintual|cert|key=apv_b") return a.name;
    if (a.notes === "import:excel|key=apv_a") return "apv-a-fintual";
    if (a.notes === "import:excel|key=apv_b") return "apv-b-fintual";
  }
  return a.name;
}

export function assetAccountSidebarLabel(a: AccountListRow): string {
  if (a.group_slug === "real_estate") return a.name.trim().toLowerCase();
  return a.name;
}
