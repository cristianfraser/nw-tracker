import { useMemo } from "react";
import { Navigate, useLocation, useParams } from "react-router-dom";
import { NavAccountsTree } from "../components/nav/NavAccountsTree";
import { GroupInfoBase } from "../components/group/GroupInfoBase";
import { CreditCardGroupSection } from "../components/liabilities/CreditCardGroupSection";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { parseLiabilitiesSubgroupParam } from "../liabilitiesPath";
import { findBestNavNodeForPathname } from "../portfolioNavFromApi";
import { resolveNavTreeLabel } from "../sidebarNavFromApi";
import { useTranslation } from "../i18n";
import { emptyCcLedger } from "../placeholders/accountDetailPlaceholders";
import { usePortfolioGroupCcLanes, usePortfolioGroupCcLedger, useSidebarNav } from "../queries/hooks";
import { queryLoadError, queryShowsLoading } from "../queries/pageShapeReady";
import { usePortfolioPageData } from "./usePortfolioPageData";
import { DASHBOARD_PATH } from "../dashboardPath";

/**
 * Pasivos › credit card (`/liabilities/credit-card`), shaped like a card's page
 * (`CreditCardGroupSection`: the cards' lanes, «Upcoming payments» beside «History», the monthly
 * detail) above the accounts tree. The Pasivos root is `LiabilitiesPage`, the mortgage group
 * `MortgageGroupPage`.
 */
export function LiabilitiesGroupPage() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const { subgroup: liabilitiesSubgroupParam } = useParams();
  const categoryFilter = useMemo(
    () => parseLiabilitiesSubgroupParam(liabilitiesSubgroupParam),
    [liabilitiesSubgroupParam]
  );

  const { displayUnit } = useDisplayPreferences();
  const { data: sidebarNav, isPending: navPending, isFetching: navFetching } = useSidebarNav(); // convention-ok: nav refetch gates «not found» only, no dim
  // Redirect away only once the nav has answered without this route; until then the page
  // renders its shell (empty title, dimmed lanes).
  const navSettled = !navPending && !navFetching;

  const navMatchNode = useMemo(
    () => findBestNavNodeForPathname(sidebarNav?.main, pathname),
    [sidebarNav, pathname]
  );
  const portfolioGroup = navMatchNode?.slug ?? "liabilities_credit_card";

  const page = usePortfolioPageData({
    portfolioGroup,
    navNode: navMatchNode ?? null,
    displayUnit,
    pathname,
    sidebarNav,
    placeholderFirstMonth: () => undefined,
    shellKeepsFirstChartDate: false,
  });
  const { data, error: queryError } = page.bundle;
  const { contentLoading, accounts, accountsTreeRoot } = page;

  // A section mounts while its ledger loads (empty ledger, dimmed). The route names the group, so
  // the ledger and the lanes start loading before the nav answers and their surfaces mount at once.
  const { data: ccLedger, isPending: ccLedgerPending } = usePortfolioGroupCcLedger(portfolioGroup);
  const ccLanesQuery = usePortfolioGroupCcLanes(portfolioGroup);
  const ccLanesError = queryLoadError(ccLanesQuery)
    ? ccLanesQuery.error instanceof Error
      ? ccLanesQuery.error.message
      : t("common.loadFailed")
    : null;

  const tableAccounts = useMemo(
    () => accounts.map((a) => ({ id: a.id, name: a.name, category_slug: a.category_slug })),
    [accounts]
  );

  const title = navMatchNode ? resolveNavTreeLabel(navMatchNode) : "";
  const error = queryLoadError({ data, error: queryError });
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;

  if (categoryFilter !== "credit_card") {
    return <Navigate to="/liabilities" replace />;
  }
  if (!navMatchNode && navSettled) {
    return <Navigate to={DASHBOARD_PATH} replace />;
  }
  if (err) {
    return (
      <main>
        <p className="error">{err}</p>
      </main>
    );
  }

  return (
    <GroupInfoBase
      title={title}
      loading={contentLoading}
      hideConsolidatedTables
      portfolio={null}
      charts={
        <CreditCardGroupSection
          portfolioGroup={portfolioGroup}
          lanes={ccLanesQuery.data}
          lanesLoading={queryShowsLoading(ccLanesQuery)}
          lanesError={ccLanesError}
          ccLedger={ccLedger ?? emptyCcLedger(0)}
          ccLedgerLoading={ccLedgerPending}
        />
      }
      tableAccounts={tableAccounts}
      accountsTree={
        accountsTreeRoot ? (
          <NavAccountsTree root={accountsTreeRoot} titleI18nKey="groupPage.accountsTreeTitleLiabilities" />
        ) : null
      }
    />
  );
}
