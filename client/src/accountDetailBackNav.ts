import {
  brokeragePortfolioGroupFromCategorySlug,
  brokeragePortfolioGroupLabel,
  brokeragePortfolioGroupPath,
} from "./brokerageGroupedAggregation";
import type { AccountListRow } from "./types";

const AFP_AFC_PARENT_LABEL = "AFP + AFC";

function normalizeHierarchyCompare(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

function hideRedundantGroupRow(
  groupRowName: string,
  accounts: AccountListRow[],
  accountLabel: (a: AccountListRow) => string
): boolean {
  return (
    accounts.length === 1 &&
    normalizeHierarchyCompare(groupRowName) === normalizeHierarchyCompare(accountLabel(accounts[0]!))
  );
}

function retirementAccountNavLabel(a: AccountListRow): string {
  if (a.category_slug === "apv") {
    if (a.notes === "import:excel|key=apv_a_principal") return "apv-a — principal";
    if (a.notes === "import:excel|key=apv_a") return "apv-a";
    if (a.notes === "import:excel|key=apv_b") return "apv-b";
  }
  return a.name;
}

/**
 * Parent link for `/account/:id` matching the “Grupos y cuentas” tree on Inversiones (root scope).
 * Skips intermediate nodes that only have one child (avoids subgroup → auto-redirect → same account).
 */
export function computeAccountDetailParentBack(
  accountId: number,
  rows: AccountListRow[]
): { to: string; label: string } | null {
  const self = rows.find((r) => r.id === accountId);
  if (!self) return null;

  const ret = rows.filter((a) => a.group_slug === "retirement");

  const portfolioGroup = brokeragePortfolioGroupFromCategorySlug(self.category_slug);
  if (self.group_slug === "brokerage" && portfolioGroup) {
    const inGroup = rows.filter(
      (a) =>
        a.group_slug === "brokerage" &&
        brokeragePortfolioGroupFromCategorySlug(a.category_slug) === portfolioGroup
    );
    if (inGroup.length > 1) {
      return {
        to: brokeragePortfolioGroupPath(portfolioGroup),
        label: brokeragePortfolioGroupLabel(portfolioGroup),
      };
    }
    return { to: "/inversiones/brokerage", label: "brokerage" };
  }

  if (self.group_slug === "brokerage") {
    return { to: "/inversiones/brokerage", label: "brokerage" };
  }

  if (self.group_slug !== "retirement") return null;

  const afpAccounts = ret.filter((a) => a.category_slug === "afp");
  const afcAccounts = ret.filter((a) => a.category_slug === "afc");
  const collapseAfp = hideRedundantGroupRow("afp", afpAccounts, retirementAccountNavLabel);
  const collapseAfc = hideRedundantGroupRow("afc", afcAccounts, retirementAccountNavLabel);
  const afpAfcBranchCount = (afpAccounts.length > 0 ? 1 : 0) + (afcAccounts.length > 0 ? 1 : 0);

  if (self.category_slug === "afp") {
    if (!collapseAfp) {
      if (afpAccounts.length > 1) {
        return { to: "/inversiones/retiro/afp", label: "afp" };
      }
      if (afpAfcBranchCount >= 2) {
        return { to: "/inversiones/retiro/afp-afc", label: AFP_AFC_PARENT_LABEL };
      }
      return { to: "/inversiones/retiro", label: "Retiro" };
    }
    if (afpAfcBranchCount >= 2) {
      return { to: "/inversiones/retiro/afp-afc", label: AFP_AFC_PARENT_LABEL };
    }
    return { to: "/inversiones/retiro", label: "Retiro" };
  }

  if (self.category_slug === "afc") {
    if (!collapseAfc) {
      if (afcAccounts.length > 1) {
        return { to: "/inversiones/retiro/afc", label: "afc" };
      }
      if (afpAfcBranchCount >= 2) {
        return { to: "/inversiones/retiro/afp-afc", label: AFP_AFC_PARENT_LABEL };
      }
      return { to: "/inversiones/retiro", label: "Retiro" };
    }
    if (afpAfcBranchCount >= 2) {
      return { to: "/inversiones/retiro/afp-afc", label: AFP_AFC_PARENT_LABEL };
    }
    return { to: "/inversiones/retiro", label: "Retiro" };
  }

  const apvPrincipal = ret.filter(
    (a) => a.category_slug === "apv" && a.notes === "import:excel|key=apv_a_principal"
  );
  const apvA = ret.filter((a) => a.category_slug === "apv" && a.notes === "import:excel|key=apv_a");
  const apvB = ret.filter((a) => a.category_slug === "apv" && a.notes === "import:excel|key=apv_b");
  const collapseApvPrincipal = hideRedundantGroupRow(
    "apv-a — principal",
    apvPrincipal,
    retirementAccountNavLabel
  );
  const collapseApvA = hideRedundantGroupRow("apv-a", apvA, retirementAccountNavLabel);
  const collapseApvB = hideRedundantGroupRow("apv-b", apvB, retirementAccountNavLabel);
  const apvRegimeBranchCount =
    (apvPrincipal.length > 0 ? 1 : 0) + (apvA.length > 0 ? 1 : 0) + (apvB.length > 0 ? 1 : 0);

  if (apvPrincipal.some((a) => a.id === accountId)) {
    if (!collapseApvPrincipal) {
      if (apvPrincipal.length > 1) {
        return { to: "/inversiones/retiro/apv/apv-a-principal", label: "apv-a — principal" };
      }
      if (apvRegimeBranchCount > 1) {
        return { to: "/inversiones/retiro/apv", label: "apv" };
      }
      return { to: "/inversiones/retiro", label: "Retiro" };
    }
    if (apvRegimeBranchCount > 1) {
      return { to: "/inversiones/retiro/apv", label: "apv" };
    }
    return { to: "/inversiones/retiro", label: "Retiro" };
  }

  if (apvA.some((a) => a.id === accountId)) {
    if (!collapseApvA) {
      if (apvA.length > 1) {
        return { to: "/inversiones/retiro/apv/apv-a", label: "apv-a" };
      }
      if (apvRegimeBranchCount > 1) {
        return { to: "/inversiones/retiro/apv", label: "apv" };
      }
      return { to: "/inversiones/retiro", label: "Retiro" };
    }
    if (apvRegimeBranchCount > 1) {
      return { to: "/inversiones/retiro/apv", label: "apv" };
    }
    return { to: "/inversiones/retiro", label: "Retiro" };
  }

  if (apvB.some((a) => a.id === accountId)) {
    if (!collapseApvB) {
      if (apvB.length > 1) {
        return { to: "/inversiones/retiro/apv/apv-b", label: "apv-b" };
      }
      if (apvRegimeBranchCount > 1) {
        return { to: "/inversiones/retiro/apv", label: "apv" };
      }
      return { to: "/inversiones/retiro", label: "Retiro" };
    }
    if (apvRegimeBranchCount > 1) {
      return { to: "/inversiones/retiro/apv", label: "apv" };
    }
    return { to: "/inversiones/retiro", label: "Retiro" };
  }

  if (self.category_slug === "apv") {
    return { to: "/inversiones/retiro/apv", label: "apv" };
  }

  return { to: "/inversiones/retiro", label: "Retiro" };
}

export type AccountSummaryNavMeta = {
  group_slug: string | null;
  group_label: string | null;
  group_peer_count: number | null;
};

/**
 * Parent link for any `/account/:id` using class-tab routes and the Inversiones tree where applicable.
 * Returns null when the only safe target is the dashboard (unknown group, or missing metadata).
 */
export function resolveAccountParentNavLink(
  accountId: number,
  meta: AccountSummaryNavMeta,
  invNavAccounts: AccountListRow[]
): { to: string; label: string } | null {
  const { group_slug, group_label, group_peer_count } = meta;
  if (!group_slug) return null;

  const peers =
    typeof group_peer_count === "number" && Number.isFinite(group_peer_count) ? group_peer_count : 0;

  if (group_slug === "retirement" || group_slug === "brokerage") {
    const inInv = invNavAccounts.some((a) => a.id === accountId);
    if (inInv) {
      const invBack = computeAccountDetailParentBack(accountId, invNavAccounts);
      if (invBack) return invBack;
    }
    if (group_slug === "brokerage") {
      return { to: "/inversiones/brokerage", label: "brokerage" };
    }
    return { to: "/inversiones/retiro", label: "Retiro" };
  }

  if (group_slug === "cash_eqs") {
    if (peers < 1) return null;
    return { to: "/cash_eqs", label: group_label?.trim() || "Cash & equivalents" };
  }
  if (group_slug === "real_estate") {
    if (peers < 1) return null;
    return { to: "/real_estate", label: group_label?.trim() || "Real estate" };
  }
  if (group_slug === "liabilities") {
    if (peers < 1) return null;
    return { to: "/liabilities", label: group_label?.trim() || "Liabilities" };
  }

  return null;
}
