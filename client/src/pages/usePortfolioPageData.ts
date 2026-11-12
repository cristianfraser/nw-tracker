import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { enrichNavTreeWithAllAccounts } from "../navAccountsTreeEnrich";
import { pathnameUsesDashboardNavContext } from "../dashboardNavContextRoutes";
import { prefetchPortfolioGroupBundle } from "../queries/displayUnitQueries";
import { extractGroupPageShellFromReal } from "../placeholders/groupPageShellFromNav";
import { buildPlaceholderPortfolioGroupBundle } from "../placeholders/groupPageChartPlaceholders";
import { buildPlaceholderNavStripDash } from "../placeholders/dashboardPagePlaceholders";
import { dashPickForNavStrip } from "../queries/fetchers";
import { writeGroupPageShellCache } from "../queries/groupPageShellCache";
import { queryKeys, type DisplayUnit } from "../queries/keys";
import { isBundleContentLoading, useRealBundleForContent } from "../queries/pageShapeReady";
import {
  useAccountsByPortfolioGroup,
  useDashboardNavContext,
  useDashboardNavSnapshot,
  useGroupPageShell,
  useHeldNavStrip,
  usePortfolioGroupBundle,
} from "../queries/hooks";
import type { NavTreeNodeDto, SidebarNavResponse } from "../types";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";

/**
 * A portfolio page's data, the one block the group and Pasivos pages shared (docs/untangle-plan.md
 * F12): the page bundle with its placeholder, the strip's own nav-context request beside it, the
 * stored snapshot and shell, the held previous-unit strip while a unit switch loads, and the shell
 * written back once the real bundle lands.
 */
export function usePortfolioPageData(opts: {
  portfolioGroup: string;
  navNode: NavTreeNodeDto | null;
  displayUnit: DisplayUnit;
  pathname: string;
  sidebarNav: SidebarNavResponse | undefined;
  /** The month the placeholder charts start from (the group pages read the shell's). */
  placeholderFirstMonth: (
    shellFirstMonth: string | null | undefined,
    snapshotFirstMonth: string | null | undefined
  ) => string | null | undefined;
  /** Store the real bundle's first chart date in the shell (the group pages do). */
  shellKeepsFirstChartDate: boolean;
}) {
  const { portfolioGroup, navNode, displayUnit, pathname, sidebarNav } = opts;
  const queryClient = useQueryClient();
  const enabled = Boolean(navNode && portfolioGroup);
  const { data: navSnapshot } = useDashboardNavSnapshot(displayUnit, enabled);
  const { data: shapeAccounts } = useAccountsByPortfolioGroup(portfolioGroup, displayUnit, enabled);
  const { data: shell } = useGroupPageShell({ portfolioGroup, unit: displayUnit, navNode, enabled });

  const bundle = usePortfolioGroupBundle({ portfolio_group: portfolioGroup, unit: displayUnit, enabled });
  const { data, isPending, isPlaceholderData } = bundle;

  useEffect(() => {
    if (!enabled) return;
    void prefetchPortfolioGroupBundle(queryClient, { portfolio_group: portfolioGroup, unit: displayUnit });
  }, [queryClient, enabled, portfolioGroup, displayUnit]);

  const firstMonth = opts.placeholderFirstMonth(shell?.first_month, navSnapshot?.chart_shape?.first_month);
  const placeholderBundle = useMemo(
    () => buildPlaceholderPortfolioGroupBundle(displayUnit, shell?.accounts ?? [], portfolioGroup, firstMonth ?? undefined, navNode),
    [displayUnit, shell?.accounts, portfolioGroup, firstMonth, navNode]
  );
  const bundleReady = Boolean(data?.ts?.accounts_in_group && data.ts.group_allocation_proportional);
  const useRealBundle = useRealBundleForContent(isPlaceholderData, bundleReady);
  const contentLoading = isBundleContentLoading({ isPending, isPlaceholderData, bundleReady });

  // The strip's own request, beside the page's: it waits for nothing the page loads.
  const navCtxQuery = useDashboardNavContext(
    displayUnit,
    navNode?.slug ?? null,
    pathnameUsesDashboardNavContext(pathname)
  );
  const navCtx = navCtxQuery.data;
  // The page holds the previous unit's bundle while the new unit loads (same-entity keep-previous):
  // with nothing of the new unit's on hand the strip keeps the previous unit's cards, dimmed and
  // in THEIR unit, and flips to the new values once they land — never a blank strip.
  const holdingPrevUnit = isPlaceholderData && bundleReady && data != null;
  const { previousDisplayUnit } = useDisplayPreferences();
  const heldStrip = useHeldNavStrip(previousDisplayUnit, holdingPrevUnit && !navSnapshot && !navCtx, navNode?.slug ?? null);
  const stripShowUsd = heldStrip ? heldStrip.showUsd : displayUnit === "usd";

  const accounts = useRealBundle && data ? data.accounts : (shapeAccounts ?? shell?.accounts ?? []);
  const accountsTreeRoot = useMemo(
    () => (navNode ? enrichNavTreeWithAllAccounts(navNode, accounts) : null),
    [navNode, accounts]
  );

  const keepFirstChartDate = opts.shellKeepsFirstChartDate;
  useEffect(() => {
    if (!bundleReady || !data || !navNode || !navCtx || !portfolioGroup) return;
    const firstChartDate = keepFirstChartDate ? data.ts.accounts_in_group?.points[0]?.as_of_date : undefined;
    const nextShell = extractGroupPageShellFromReal(
      data.accounts,
      navCtx.accounts,
      navNode,
      typeof firstChartDate === "string" ? firstChartDate : undefined
    );
    writeGroupPageShellCache(portfolioGroup, displayUnit, nextShell);
    queryClient.setQueryData(queryKeys.groupPageShell(portfolioGroup, displayUnit), nextShell);
  }, [bundleReady, data, navCtx, navNode, portfolioGroup, displayUnit, queryClient, keepFirstChartDate]);

  // No snapshot yet: nav-context alone, else a zero strip from the sidebar nav (cold cache).
  const placeholderStripDash = useMemo(
    () => (sidebarNav ? buildPlaceholderNavStripDash(sidebarNav, displayUnit) : null),
    [sidebarNav, displayUnit]
  );
  const stripIsPlaceholder = navNode != null && !navSnapshot && !navCtx && !heldStrip;
  const dashForStrip = useMemo(() => {
    if (!navNode) return null;
    if (heldStrip) return heldStrip.dash;
    if (!navSnapshot) return navCtx ? dashPickForNavStrip(navCtx) : placeholderStripDash;
    return dashPickForNavStrip({
      accounts: navCtx ? navCtx.accounts : navSnapshot.accounts,
      liabilities_breakdown: navCtx?.liabilities_breakdown ?? navSnapshot.liabilities_breakdown,
      dashboard_layout: navCtx?.dashboard_layout ?? navSnapshot.dashboard_layout,
      card_metrics_by_slug: navCtx?.card_metrics_by_slug ?? navSnapshot.card_metrics_by_slug,
    });
  }, [navNode, navCtx, navSnapshot, placeholderStripDash, heldStrip]);

  return {
    bundle,
    navSnapshot,
    shell,
    navCtxQuery,
    bundleReady,
    useRealBundle,
    contentLoading,
    heldStrip,
    stripShowUsd,
    accounts,
    accountsTreeRoot,
    stripIsPlaceholder,
    dashForStrip,
    /** The real bundle once ready, else its placeholder. */
    resolved: useRealBundle && data ? data : placeholderBundle,
  };
}
