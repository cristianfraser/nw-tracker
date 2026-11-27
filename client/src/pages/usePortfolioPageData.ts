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
import { bundleContent } from "../queries/pageShapeReady";
import {
  useAccountsByPortfolioGroup,
  useDashboardNavSnapshot,
  useGroupPageShell,
  useHeldDashboardNavContext,
  useHeldPortfolioGroupBundle,
} from "../queries/hooks";
import type { NavTreeNodeDto, SidebarNavResponse } from "../types";

/** A strip's figures, the unit they are in, and whether they are the nav context's (else the
 * stored snapshot's). */
type StripCards = {
  dash: ReturnType<typeof dashPickForNavStrip>;
  unit: DisplayUnit;
  fromContext: boolean;
};

/**
 * A portfolio page's data, the one block the group and Pasivos pages shared (docs/untangle-plan.md
 * F12): the page bundle (this unit's, or the one held across a unit switch, `heldUnitPayload.ts`)
 * with its placeholder, the page's nav context beside it (held the same way: the strip, the
 * glance blocks and the value map all read it), the stored snapshot and shell, the strip built
 * from the nav context on screen, and the shell written back from this unit's live payloads.
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

  const heldBundle = useHeldPortfolioGroupBundle({ portfolio_group: portfolioGroup, unit: displayUnit, enabled });

  useEffect(() => {
    if (!enabled) return;
    void prefetchPortfolioGroupBundle(queryClient, { portfolio_group: portfolioGroup, unit: displayUnit });
  }, [queryClient, enabled, portfolioGroup, displayUnit]);

  const firstMonth = opts.placeholderFirstMonth(shell?.first_month, navSnapshot?.chart_shape?.first_month);
  const placeholderBundle = useMemo(
    () => buildPlaceholderPortfolioGroupBundle(displayUnit, shell?.accounts ?? [], portfolioGroup, firstMonth ?? undefined, navNode),
    [displayUnit, shell?.accounts, portfolioGroup, firstMonth, navNode]
  );
  const { content, loading: contentLoading, live } = bundleContent(heldBundle, (d) =>
    Boolean(d.ts?.accounts_in_group && d.ts.group_allocation_proportional)
  );

  // The nav context's own request, beside the page's: it waits for nothing the page loads. Held
  // once here; every surface reading it (strip, glance blocks, value map) draws this copy.
  const navCtxEnabled = pathnameUsesDashboardNavContext(pathname) && navNode != null;
  const navCtx = useHeldDashboardNavContext(displayUnit, navNode?.slug ?? null, navCtxEnabled);
  const liveNavCtx = navCtx.live;

  const accounts = content ? content.accounts : (shapeAccounts ?? shell?.accounts ?? []);
  const accountsTreeRoot = useMemo(
    () => (navNode ? enrichNavTreeWithAllAccounts(navNode, accounts) : null),
    [navNode, accounts]
  );

  // No snapshot yet: nav-context alone, else a zero strip from the sidebar nav (cold cache).
  const placeholderStripDash = useMemo(
    () => (sidebarNav ? buildPlaceholderNavStripDash(sidebarNav) : null),
    [sidebarNav]
  );
  // The strip follows the nav context's own decision (`heldUnitPayload.ts`): the context on
  // screen — this unit's, or the one held across a switch, in ITS unit, dimmed — with the stored
  // snapshot filling fields it leaves out (same unit only). Only while the page shows no context
  // at all (first paint) the stored snapshot alone paints it, dimmed; a failed context paints
  // nothing (the page reports `navCtx.error`).
  const shownCtx = navCtx.data;
  const failedCtx = navCtx.error != null;
  const stripCards = useMemo((): StripCards | undefined => {
    if (!navNode) return undefined;
    if (shownCtx) {
      const fill = navSnapshot && navSnapshot.unit === shownCtx.unit ? navSnapshot : null;
      return {
        dash: fill
          ? dashPickForNavStrip({
              accounts: shownCtx.accounts,
              liabilities_breakdown: shownCtx.liabilities_breakdown ?? fill.liabilities_breakdown,
              dashboard_layout: shownCtx.dashboard_layout ?? fill.dashboard_layout,
              card_metrics_by_slug: shownCtx.card_metrics_by_slug ?? fill.card_metrics_by_slug,
            })
          : dashPickForNavStrip(shownCtx),
        unit: shownCtx.unit,
        fromContext: true,
      };
    }
    if (!navSnapshot || failedCtx) return undefined;
    return {
      dash: dashPickForNavStrip({
        accounts: navSnapshot.accounts,
        liabilities_breakdown: navSnapshot.liabilities_breakdown,
        dashboard_layout: navSnapshot.dashboard_layout,
        card_metrics_by_slug: navSnapshot.card_metrics_by_slug,
      }),
      unit: navSnapshot.unit,
      fromContext: false,
    };
  }, [navNode, shownCtx, navSnapshot, failedCtx]);
  /** The unit the strip's cards are in: the held cards' own while a switch loads. */
  const stripUnit: DisplayUnit = stripCards?.unit ?? displayUnit;
  /** Dim the strip: zero cards, a held or pending context, or a stored snapshot. */
  const stripIsPlaceholder = navNode != null && (stripCards == null || navCtx.loading || !stripCards.fromContext);
  const dashForStrip = navNode ? (stripCards?.dash ?? placeholderStripDash) : null;

  // Only this unit's live payloads are written under its key: the live bundle and the live nav
  // context (never a held one, nor an older copy the seam is hiding).
  const keepFirstChartDate = opts.shellKeepsFirstChartDate;
  useEffect(() => {
    if (!live || !navNode || !liveNavCtx || !portfolioGroup) return;
    const firstChartDate = keepFirstChartDate ? live.ts.accounts_in_group?.points[0]?.as_of_date : undefined;
    const nextShell = extractGroupPageShellFromReal(
      live.accounts,
      liveNavCtx.accounts,
      navNode,
      typeof firstChartDate === "string" ? firstChartDate : undefined
    );
    writeGroupPageShellCache(portfolioGroup, displayUnit, nextShell);
    queryClient.setQueryData(queryKeys.groupPageShell(portfolioGroup, displayUnit), nextShell);
  }, [live, liveNavCtx, navNode, portfolioGroup, displayUnit, queryClient, keepFirstChartDate]);

  return {
    /** The page bundle's load error (only when it has nothing to show, `heldUnitPayload.ts`). */
    bundleError: heldBundle.error,
    navSnapshot,
    shell,
    /** The page's nav context: this unit's, or the one held across a switch (format it with its
     * own `unit`; dim on `loading`; `error` when it failed with nothing to show). */
    navCtx,
    contentLoading,
    stripUnit,
    accounts,
    accountsTreeRoot,
    stripIsPlaceholder,
    dashForStrip,
    /** The bundle on screen (this unit's or the one held, in its own unit), else its placeholder. */
    resolved: content ?? placeholderBundle,
  };
}
