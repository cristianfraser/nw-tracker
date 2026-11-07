import type {
  DashboardNavSnapshotResponse,
  DashboardResponse,
  NavCardMetricsDto,
  NavTreeNodeDto,
  SidebarNavResponse,
} from "../types";
import type { DisplayUnit } from "./keys";
import {
  hasSchemaVersion,
  persistedPayload,
  readPersistedPayload,
  removePersistedPayload,
  writePersistedPayload,
} from "./persistedPayloadCache";
import { readSidebarNavCache } from "./sidebarNavCache";

/**
 * True when an entry carries the fields this client reads. A snapshot can be saved by a new
 * client from a server still on the previous payload (a restart lagging a deploy: v13 lacked
 * `parent_pct` that way, and on 2026-10-28 a v15 snapshot lacked `value`, which crashed every
 * card page on reload), so a version bump alone does not keep an old shape out.
 */
function navCardMetricsEntryHasCurrentShape(entry: NavCardMetricsDto): boolean {
  if (entry.value == null || entry.parent_pct == null) return false;
  return entry.liquidated == null || entry.liquidated.value != null;
}

/**
 * True when a cached snapshot's `card_metrics_by_slug` has an entry, in the current shape, for
 * every group node the current nav tree can render as a card — the node set the server keys
 * (net_worth tree + the Pasivos root, account leaves skipped; `buildNavCardMetricsBySlug`). A
 * snapshot saved before a node existed, or from a server on an older payload, must never be
 * rendered: `requireNavCardMetrics` and its readers would throw on it. An unknown nav (first
 * visit, nothing cached yet) is not a mismatch — no strip renders without a tree.
 */
export function navSnapshotCoversNavTree(
  cardMetricsBySlug: DashboardResponse["card_metrics_by_slug"] | undefined,
  nav: SidebarNavResponse | null | undefined
): boolean {
  if (!nav) return true;
  const roots = [nav.net_worth, nav.main.find((n) => n.slug === "liabilities")];
  const covers = (n: NavTreeNodeDto): boolean => {
    const cardNode = n.account_id == null && n.expense_account_id == null;
    if (cardNode) {
      const entry = cardMetricsBySlug?.[n.slug];
      if (!entry || !navCardMetricsEntryHasCurrentShape(entry)) return false;
    }
    return (n.children ?? []).every(covers);
  };
  return roots.every((root) => root == null || covers(root));
}

/** True when localStorage has a nav-snapshot row for this unit. */
export function hasDashboardNavSnapshotCache(unit: DisplayUnit): boolean {
  return readDashboardNavSnapshotCache(unit) != null;
}

/** The stored card strip, per unit (`DTO_SCHEMA_VERSIONS.nav_strip`). */
const NAV_STRIP = persistedPayload(
  "nav_strip",
  (v): v is DashboardNavSnapshotResponse =>
    hasSchemaVersion(v, "nav_strip") &&
    Array.isArray((v as DashboardNavSnapshotResponse).accounts) &&
    (v as DashboardNavSnapshotResponse).card_metrics_by_slug != null
);

/** Strip full dashboard totals to nav-snapshot bucket fields (server canonical card headers). */
export function nwBucketTotalsFromDashTotals(
  totals: DashboardResponse["totals"]
): DashboardNavSnapshotResponse["nw_bucket_totals"] {
  return {
    net_worth_clp: totals.net_worth_clp,
    real_estate_clp: totals.real_estate_clp,
    retirement_clp: totals.retirement_clp,
    brokerage_clp: totals.brokerage_clp,
    cash_eqs_clp: totals.cash_eqs_clp,
    prior_closes: totals.prior_closes,
    net_worth_usd: totals.net_worth_usd,
    real_estate_usd: totals.real_estate_usd,
    retirement_usd: totals.retirement_usd,
    brokerage_usd: totals.brokerage_usd,
    cash_eqs_usd: totals.cash_eqs_usd,
  };
}

export function readDashboardNavSnapshotCache(
  unit: DisplayUnit
): DashboardNavSnapshotResponse | undefined {
  const snapshot = readPersistedPayload(NAV_STRIP, [unit]);
  if (!snapshot) return undefined;
  // Checked against the latest known nav tree (the sidebar-nav cache is written before a
  // fresh tree reaches any component): a snapshot that no longer covers it is discarded, so
  // every `hasDashboardNavSnapshotCache` gate flips and the live snapshot / nav context load.
  if (!navSnapshotCoversNavTree(snapshot.card_metrics_by_slug, readSidebarNavCache())) {
    removePersistedPayload(NAV_STRIP, [unit]);
    return undefined;
  }
  return snapshot;
}

export function writeDashboardNavSnapshotCache(
  unit: DisplayUnit,
  snapshot: DashboardNavSnapshotResponse
): void {
  writePersistedPayload(NAV_STRIP, [unit], snapshot);
}

/**
 * Merges one page's nav-context into the stored snapshot: its card figures and account rows
 * replace the stored ones, everything outside the page is kept, and the whole-tree totals,
 * layout and liabilities breakdown come from the context. Nav-context covers one page only, so
 * with no stored snapshot nothing is written (a partial snapshot would not cover the nav tree).
 */
export function mergeNavContextIntoSnapshotCache(
  unit: DisplayUnit,
  ctx: Pick<
    DashboardNavSnapshotResponse,
    "accounts" | "liabilities_breakdown" | "dashboard_layout" | "nw_bucket_totals" | "card_metrics_by_slug"
  > & { schema_version?: number }
): void {
  const stored = readDashboardNavSnapshotCache(unit);
  if (!stored) return;
  const fresh = new Map(ctx.accounts.map((a) => [a.account_id, a]));
  const accounts = stored.accounts.map((a) => fresh.get(a.account_id) ?? a);
  const storedIds = new Set(stored.accounts.map((a) => a.account_id));
  for (const a of ctx.accounts) if (!storedIds.has(a.account_id)) accounts.push(a);
  writeDashboardNavSnapshotCache(unit, {
    ...stored,
    // A context from a server on another version must not be merged in under the stored one's.
    schema_version: ctx.schema_version as DashboardNavSnapshotResponse["schema_version"],
    accounts,
    liabilities_breakdown: ctx.liabilities_breakdown,
    dashboard_layout: ctx.dashboard_layout,
    nw_bucket_totals: ctx.nw_bucket_totals,
    card_metrics_by_slug: { ...stored.card_metrics_by_slug, ...ctx.card_metrics_by_slug },
  });
}
