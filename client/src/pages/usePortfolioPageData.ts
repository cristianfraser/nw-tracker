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
import { useHeldUnitValue } from "../queries/heldUnitPayload";
import {
  useAccountsByPortfolioGroup,
  useDashboardNavSnapshot,
  useGroupPageShell,
  useHeldDashboardNavContext,
  useHeldPortfolioGroupBundle,
} from "../queries/hooks";
import type { DashboardNavContext } from "../queries/fetchers";
import type { NavTreeNodeDto, SidebarNavResponse } from "../types";

/** A strip's figures, the unit they are in, and the live nav context they come from (if any). */
type StripCards = {
  dash: ReturnType<typeof dashPickForNavStrip>;
  unit: DisplayUnit;
  navCtx: DashboardNavContext | null;
};

/**
 * A portfolio page's data, the one block the group and Pasivos pages shared (docs/untangle-plan.md
 * F12): the page bundle (this unit's, or the one held across a unit switch, `heldUnitPayload.ts`)
 * with its placeholder, the page's nav context beside it (held the same way: the strip, the
 * glance blocks and the value map all read it), the stored snapshot and shell, the strip held on
 * screen while a unit switch loads, and the shell written back from this unit's live payloads.
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
  const navSnapshotQuery = useDashboardNavSnapshot(displayUnit, enabled);
  const navSnapshot = navSnapshotQuery.data;
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
  // The strip's candidate in this unit: the live nav context (over the snapshot's missing
  // fields), else — only while the page shows no nav context at all — the stored snapshot,
  // updated at 0 when read from storage, so it paints only a strip that shows nothing yet. While
  // the nav context is held across a switch there is no candidate: the cards on screen stay,
  // dimmed and in THEIR unit (the nav context's hold refetches an older copy).
  // Memoized on the payloads only: the cards' identity dates their content (`heldUnitPayload.ts`).
  const snapshotAllowed = navCtx.data === undefined;
  const stripCandidateCards = useMemo((): StripCards | undefined => {
    if (liveNavCtx) {
      return {
        dash: navSnapshot
          ? dashPickForNavStrip({
              accounts: liveNavCtx.accounts,
              liabilities_breakdown: liveNavCtx.liabilities_breakdown ?? navSnapshot.liabilities_breakdown,
              dashboard_layout: liveNavCtx.dashboard_layout ?? navSnapshot.dashboard_layout,
              card_metrics_by_slug: liveNavCtx.card_metrics_by_slug ?? navSnapshot.card_metrics_by_slug,
            })
          : dashPickForNavStrip(liveNavCtx),
        unit: liveNavCtx.unit,
        navCtx: liveNavCtx,
      };
    }
    if (!navSnapshot || !snapshotAllowed) return undefined;
    return {
      dash: dashPickForNavStrip({
        accounts: navSnapshot.accounts,
        liabilities_breakdown: navSnapshot.liabilities_breakdown,
        dashboard_layout: navSnapshot.dashboard_layout,
        card_metrics_by_slug: navSnapshot.card_metrics_by_slug,
      }),
      unit: navSnapshot.unit,
      navCtx: null,
    };
  }, [liveNavCtx, navSnapshot, snapshotAllowed]);
  const strip = useHeldUnitValue({
    candidate: stripCandidateCards
      ? {
          data: stripCandidateCards,
          updatedAt: stripCandidateCards.navCtx ? navCtx.updatedAt : navSnapshotQuery.dataUpdatedAt,
        }
      : undefined,
    pending: stripCandidateCards === undefined,
    unit: displayUnit,
    entity: navNode?.slug ?? "",
    key: displayUnit,
    refetch: navCtxEnabled ? navCtx.refetch : undefined,
  });
  const stripCards = navNode ? (strip.data ?? null) : null;
  /** The unit the strip's cards are in: the held cards' own while a switch loads. */
  const stripUnit: DisplayUnit = stripCards?.unit ?? displayUnit;
  /** Dim the strip: zero cards, held cards, or a stored snapshot (not this unit's live context). */
  const stripIsPlaceholder = navNode != null && (stripCards == null || strip.held || stripCards.navCtx == null);
  const dashForStrip = navNode ? (stripCards?.dash ?? placeholderStripDash) : null;

  // Only this unit's live payloads are written under its key: the live bundle and the live nav
  // context the strip shows (never a held bundle, nor an older context the strip is hiding).
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
     * own `unit`; dim on `loading`). */
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
