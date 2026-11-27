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
import { useHeldUnitQuery, useHeldUnitValue, type UnitCandidate } from "../queries/heldUnitPayload";
import {
  useAccountsByPortfolioGroup,
  useDashboardNavContext,
  useDashboardNavSnapshot,
  useGroupPageShell,
  usePortfolioGroupBundle,
} from "../queries/hooks";
import type { NavTreeNodeDto, SidebarNavResponse } from "../types";

/** A strip's figures and the unit they are in. */
type StripCards = { dash: ReturnType<typeof dashPickForNavStrip>; unit: DisplayUnit };

/**
 * A portfolio page's data, the one block the group and Pasivos pages shared (docs/untangle-plan.md
 * F12): the page bundle (this unit's, or the one held across a unit switch, `heldUnitPayload.ts`)
 * with its placeholder, the strip's own nav-context request beside it, the stored snapshot and
 * shell, the strip held on screen while a unit switch loads, and the shell written back from this
 * unit's live payloads.
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

  const bundle = usePortfolioGroupBundle({ portfolio_group: portfolioGroup, unit: displayUnit, enabled });
  const heldBundle = useHeldUnitQuery(bundle, {
    queryKey: queryKeys.portfolioGroup(portfolioGroup, displayUnit),
    unit: displayUnit,
    enabled,
  });

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

  // The strip's own request, beside the page's: it waits for nothing the page loads.
  const navCtxEnabled = pathnameUsesDashboardNavContext(pathname) && navNode != null;
  const navCtxQuery = useDashboardNavContext(displayUnit, navNode?.slug ?? null, navCtxEnabled);
  const navCtx = navCtxQuery.data;

  const accounts = content ? content.accounts : (shapeAccounts ?? shell?.accounts ?? []);
  const accountsTreeRoot = useMemo(
    () => (navNode ? enrichNavTreeWithAllAccounts(navNode, accounts) : null),
    [navNode, accounts]
  );

  const keepFirstChartDate = opts.shellKeepsFirstChartDate;
  // Only this unit's live payloads are written under its key (never a held bundle).
  useEffect(() => {
    if (!live || !navNode || !navCtx || !portfolioGroup) return;
    const firstChartDate = keepFirstChartDate ? live.ts.accounts_in_group?.points[0]?.as_of_date : undefined;
    const nextShell = extractGroupPageShellFromReal(
      live.accounts,
      navCtx.accounts,
      navNode,
      typeof firstChartDate === "string" ? firstChartDate : undefined
    );
    writeGroupPageShellCache(portfolioGroup, displayUnit, nextShell);
    queryClient.setQueryData(queryKeys.groupPageShell(portfolioGroup, displayUnit), nextShell);
  }, [live, navCtx, navNode, portfolioGroup, displayUnit, queryClient, keepFirstChartDate]);

  // No snapshot yet: nav-context alone, else a zero strip from the sidebar nav (cold cache).
  const placeholderStripDash = useMemo(
    () => (sidebarNav ? buildPlaceholderNavStripDash(sidebarNav) : null),
    [sidebarNav]
  );
  // The strip's candidate in this unit: its live nav context (over the snapshot's missing
  // fields), else the stored snapshot — updated at 0 when read from storage, so it paints only a
  // strip that shows nothing yet. Across a unit switch the cards on screen stay, dimmed and in
  // THEIR unit, until a copy of this unit at least as new is in (an older nav context is refetched).
  const stripCandidate = useMemo((): UnitCandidate<StripCards> | undefined => {
    if (navCtx) {
      return {
        data: {
          dash: navSnapshot
            ? dashPickForNavStrip({
                accounts: navCtx.accounts,
                liabilities_breakdown: navCtx.liabilities_breakdown ?? navSnapshot.liabilities_breakdown,
                dashboard_layout: navCtx.dashboard_layout ?? navSnapshot.dashboard_layout,
                card_metrics_by_slug: navCtx.card_metrics_by_slug ?? navSnapshot.card_metrics_by_slug,
              })
            : dashPickForNavStrip(navCtx),
          unit: displayUnit,
        },
        updatedAt: navCtxQuery.dataUpdatedAt,
      };
    }
    if (!navSnapshot) return undefined;
    return {
      data: {
        dash: dashPickForNavStrip({
          accounts: navSnapshot.accounts,
          liabilities_breakdown: navSnapshot.liabilities_breakdown,
          dashboard_layout: navSnapshot.dashboard_layout,
          card_metrics_by_slug: navSnapshot.card_metrics_by_slug,
        }),
        unit: navSnapshot.unit,
      },
      updatedAt: navSnapshotQuery.dataUpdatedAt,
    };
  }, [navCtx, navCtxQuery.dataUpdatedAt, navSnapshot, navSnapshotQuery.dataUpdatedAt, displayUnit]);
  const strip = useHeldUnitValue({
    candidate: stripCandidate,
    pending: stripCandidate === undefined,
    unit: displayUnit,
    entity: navNode?.slug ?? "",
    key: displayUnit,
    refetch: navCtxEnabled ? () => navCtxQuery.refetch({ cancelRefetch: false }) : undefined,
  });
  const stripCards = navNode ? (strip.data ?? null) : null;
  /** The unit the strip's cards are in: the held cards' own while a switch loads. */
  const stripUnit: DisplayUnit = stripCards?.unit ?? displayUnit;
  /** Dim the strip: zero cards, held cards, or a stored snapshot (not this unit's live context). */
  const stripIsPlaceholder = navNode != null && (stripCards == null || strip.held || navCtx == null);
  const dashForStrip = navNode ? (stripCards?.dash ?? placeholderStripDash) : null;

  return {
    bundle,
    navSnapshot,
    shell,
    navCtxQuery,
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
