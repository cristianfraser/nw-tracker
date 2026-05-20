import {
  BROKERAGE_GROUP_ORDER,
  brokeragePortfolioGroupFromCategorySlug,
  brokeragePortfolioGroupLabel,
  brokeragePortfolioGroupPath,
  type BrokeragePortfolioGroup,
} from "./brokerageGroupedAggregation";
import {
  assetAccountSidebarLabel,
  brokerageAccountNavLabel,
  hideRedundantGroupRow,
  liabilityCategoryNavLabel,
  retirementAccountNavLabel,
} from "./navAccountLabels";
import i18n from "./i18n";
import type { AccountListRow, ExpenseApartmentSlug } from "./types";

export type SidebarNavNode = {
  id: string;
  label: string;
  to: string;
  end?: boolean;
  activePrefix?: string;
  children?: SidebarNavNode[];
  /** Leaf rows: show hyphen in the caret column. Default true; set false for top-level links like rates. */
  showLeafHyphen?: boolean;
};

function accountLeaf(id: string, a: AccountListRow, label: (a: AccountListRow) => string): SidebarNavNode {
  return {
    id,
    label: label(a),
    to: `/account/${a.id}`,
    end: true,
  };
}

function accountLeaves(
  prefix: string,
  accounts: AccountListRow[],
  label: (a: AccountListRow) => string
): SidebarNavNode[] {
  return accounts.map((a) => accountLeaf(`${prefix}.acc.${a.id}`, a, label));
}

function maybeSubgroup(
  id: string,
  groupLabel: string,
  to: string,
  accounts: AccountListRow[],
  accountLabel: (a: AccountListRow) => string
): SidebarNavNode | null {
  if (accounts.length === 0) return null;
  if (hideRedundantGroupRow(groupLabel, accounts, accountLabel)) {
    const a = accounts[0]!;
    return accountLeaf(id, a, accountLabel);
  }
  return {
    id,
    label: groupLabel,
    to,
    children: accountLeaves(id, accounts, accountLabel),
  };
}

function buildBrokerageSubgroup(
  inv: AccountListRow[],
  group: BrokeragePortfolioGroup
): SidebarNavNode | null {
  const inGroup = inv.filter((a) => brokeragePortfolioGroupFromCategorySlug(a.category_slug) === group);
  const label = brokeragePortfolioGroupLabel(group).toLowerCase();
  const path = brokeragePortfolioGroupPath(group);
  return maybeSubgroup(`inv.brokerage.${group}`, label, path, inGroup, brokerageAccountNavLabel);
}

function buildBrokerageBranch(inv: AccountListRow[]): SidebarNavNode {
  const children = BROKERAGE_GROUP_ORDER.map((g) => buildBrokerageSubgroup(inv, g)).filter(
    (n): n is SidebarNavNode => n != null
  );
  return {
    id: "inv.brokerage",
    label: i18n.t("dashboard.cards.brokerage"),
    to: "/inversiones/brokerage",
    activePrefix: "/inversiones/brokerage",
    children,
  };
}

function buildApvBranch(inv: AccountListRow[]): SidebarNavNode | null {
  const apv = inv.filter((a) => a.category_slug === "apv");
  if (apv.length === 0) return null;

  const principal = apv.filter((a) => a.notes === "import:excel|key=apv_a_principal");
  const apvA = apv.filter((a) => a.notes === "import:excel|key=apv_a");
  const apvB = apv.filter((a) => a.notes === "import:excel|key=apv_b");
  const other = apv.filter(
    (a) =>
      a.notes !== "import:excel|key=apv_a_principal" &&
      a.notes !== "import:excel|key=apv_a" &&
      a.notes !== "import:excel|key=apv_b"
  );

  const apvAChildren: SidebarNavNode[] = [
    ...accountLeaves("retiro.apv.a.principal", principal, retirementAccountNavLabel),
    ...accountLeaves("retiro.apv.a.fintual", apvA, retirementAccountNavLabel),
  ];

  const children: SidebarNavNode[] = [];
  if (apvAChildren.length > 0) {
    children.push({
      id: "retiro.apv.a",
      label: "apv-a",
      to: "/inversiones/retiro/apv/apv-a",
      activePrefix: "/inversiones/retiro/apv/apv-a",
      children: apvAChildren,
    });
  }
  const apvBNode = maybeSubgroup(
    "retiro.apv.b",
    "apv-b",
    "/inversiones/retiro/apv/apv-b",
    apvB,
    retirementAccountNavLabel
  );
  if (apvBNode) children.push(apvBNode);
  children.push(...accountLeaves("retiro.apv.other", other, retirementAccountNavLabel));

  if (children.length === 0) return null;
  return {
    id: "retiro.apv",
    label: i18n.t("retirement.apv"),
    to: "/inversiones/retiro/apv",
    activePrefix: "/inversiones/retiro/apv",
    children,
  };
}

function buildRetiroBranch(inv: AccountListRow[]): SidebarNavNode {
  const ret = inv.filter((a) => a.group_slug === "retirement");
  const afp = ret.filter((a) => a.category_slug === "afp");
  const afc = ret.filter((a) => a.category_slug === "afc");

  const children: SidebarNavNode[] = [];

  if (afp.length > 0 || afc.length > 0) {
    const afpAfcChildren: SidebarNavNode[] = [];
    const afpNode = maybeSubgroup(
      "retiro.afp",
      i18n.t("sidebar.afp"),
      "/inversiones/retiro/afp",
      afp,
      retirementAccountNavLabel
    );
    const afcNode = maybeSubgroup(
      "retiro.afc",
      i18n.t("sidebar.afc"),
      "/inversiones/retiro/afc",
      afc,
      retirementAccountNavLabel
    );
    if (afpNode) afpAfcChildren.push(afpNode);
    if (afcNode) afpAfcChildren.push(afcNode);
    children.push({
      id: "retiro.afp-afc",
      label: i18n.t("retirement.afpAfc"),
      to: "/inversiones/retiro/afp-afc",
      activePrefix: "/inversiones/retiro/afp-afc",
      children: afpAfcChildren,
    });
  }

  const apvNode = buildApvBranch(ret);
  if (apvNode) children.push(apvNode);

  return {
    id: "inv.retiro",
    label: i18n.t("dashboard.cards.retirement"),
    to: "/inversiones/retiro",
    activePrefix: "/inversiones/retiro",
    children,
  };
}

function buildInversionesBranch(inv: AccountListRow[]): SidebarNavNode {
  return {
    id: "inversiones",
    label: i18n.t("sidebar.inversiones"),
    to: "/inversiones",
    activePrefix: "/inversiones",
    children: [buildBrokerageBranch(inv), buildRetiroBranch(inv)],
  };
}

function buildCategoryBranch(
  id: string,
  accounts: AccountListRow[],
  categorySlug: string
): SidebarNavNode | null {
  const inCat = accounts.filter((a) => a.category_slug === categorySlug);
  if (inCat.length === 0) return null;
  const label = liabilityCategoryNavLabel(categorySlug);
  return maybeSubgroup(id, label, "/liabilities", inCat, assetAccountSidebarLabel);
}

function buildLiabilitiesBranch(accounts: AccountListRow[]): SidebarNavNode {
  const children: SidebarNavNode[] = [];
  const cc = buildCategoryBranch("liabilities.cc", accounts, "credit_card");
  const mtg = buildCategoryBranch("liabilities.mortgage", accounts, "mortgage");
  if (cc) children.push(cc);
  if (mtg) children.push(mtg);

  return {
    id: "liabilities",
    label: i18n.t("dashboard.cards.liabilities"),
    to: "/liabilities",
    children,
  };
}

function buildRealEstateBranch(accounts: AccountListRow[]): SidebarNavNode {
  return {
    id: "real_estate",
    label: i18n.t("dashboard.buckets.real_estate"),
    to: "/real_estate",
    children: accountLeaves("real_estate", accounts, assetAccountSidebarLabel),
  };
}

function buildCashBranch(accounts: AccountListRow[]): SidebarNavNode {
  const children = accountLeaves("cash", accounts, assetAccountSidebarLabel);
  return {
    id: "cash",
    label: i18n.t("dashboard.buckets.cash_eqs"),
    to: "/cash_eqs",
    children: children.length > 0 ? children : undefined,
  };
}

export type SidebarAccountsBundle = {
  cash: AccountListRow[];
  liabilities: AccountListRow[];
  realEstate: AccountListRow[];
  inversiones: AccountListRow[];
};

function buildFlowsExpensesBranch(): SidebarNavNode {
  const apartments: ExpenseApartmentSlug[] = ["el_vergel", "lastarria", "suecia"];
  return {
    id: "flows.expenses",
    label: i18n.t("sidebar.flowsExpenses"),
    to: "/flows/expenses",
    activePrefix: "/flows/expenses",
    children: [
      {
        id: "flows.expenses.real_estate",
        label: i18n.t("sidebar.flowsExpensesRealEstate"),
        to: "/flows/expenses/real_estate",
        activePrefix: "/flows/expenses/real_estate",
        children: apartments.map((slug) => ({
          id: `flows.expenses.real_estate.${slug}`,
          label: i18n.t(`expenses.accounts.${slug}`),
          to: `/flows/expenses/real_estate/${slug}`,
          end: true,
        })),
      },
    ],
  };
}

export function buildSidebarNavTree(data: SidebarAccountsBundle): SidebarNavNode[] {
  return [
    { id: "dashboard", label: i18n.t("dashboard.title"), to: "/", end: true, showLeafHyphen: false },
    buildCashBranch(data.cash),
    buildLiabilitiesBranch(data.liabilities),
    buildRealEstateBranch(data.realEstate),
    buildInversionesBranch(data.inversiones),
    {
      id: "flows",
      label: i18n.t("sidebar.flows"),
      to: "/flows",
      activePrefix: "/flows",
      children: [
        { id: "flows.income", label: i18n.t("sidebar.flowsIncome"), to: "/flows/income", end: true },
        buildFlowsExpensesBranch(),
        { id: "flows.deposits", label: i18n.t("sidebar.flowsDeposits"), to: "/flows/deposits", end: true },
      ],
    },
    { id: "rates", label: i18n.t("sidebar.rates"), to: "/rates", showLeafHyphen: false },
  ];
}

export function sidebarNodeMatchesPath(pathname: string, node: SidebarNavNode): boolean {
  if (node.end) return pathname === node.to;
  if (node.activePrefix) return pathname === node.activePrefix || pathname.startsWith(`${node.activePrefix}/`);
  return pathname === node.to || pathname.startsWith(`${node.to}/`);
}

export function collectAncestorIdsToExpand(nodes: SidebarNavNode[], pathname: string): string[] {
  const ids: string[] = [];
  function walk(list: SidebarNavNode[]): boolean {
    for (const node of list) {
      const childHit = node.children?.length ? walk(node.children) : false;
      const selfHit =
        pathname === node.to ||
        (node.children?.length ? sidebarNodeMatchesPath(pathname, node) : false);
      if (childHit) {
        if (node.children?.length) ids.push(node.id);
        return true;
      }
      if (selfHit) return true;
    }
    return false;
  }
  walk(nodes);
  return ids;
}
