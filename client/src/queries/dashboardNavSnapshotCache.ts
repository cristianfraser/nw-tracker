import type {
  DashboardNavSnapshotResponse,
  DashboardResponse,
  NavTreeNodeDto,
  SidebarNavResponse,
} from "../types";
import type { DisplayUnit } from "./keys";
import { readSidebarNavCache } from "./sidebarNavCache";

/**
 * True when a cached snapshot's `card_metrics_by_slug` has an entry for every group node the
 * current nav tree can render as a card — the node set the server keys (net_worth tree + the
 * Pasivos root, account leaves skipped; `buildNavCardMetricsBySlug`). A snapshot saved before a
 * node existed must never be rendered: `requireNavCardMetrics` would throw on it. An unknown
 * nav (first visit, nothing cached yet) is not a mismatch — no strip renders without a tree.
 */
export function navSnapshotCoversNavTree(
  cardMetricsBySlug: DashboardResponse["card_metrics_by_slug"] | undefined,
  nav: SidebarNavResponse | null | undefined
): boolean {
  if (!nav) return true;
  const roots = [nav.net_worth, nav.main.find((n) => n.slug === "liabilities")];
  const covers = (n: NavTreeNodeDto): boolean => {
    const cardNode = n.account_id == null && n.expense_account_id == null;
    if (cardNode && !cardMetricsBySlug?.[n.slug]) return false;
    return (n.children ?? []).every(covers);
  };
  return roots.every((root) => root == null || covers(root));
}

/** True when localStorage has a nav-snapshot row for this unit (CLP fallback for USD). */
export function hasDashboardNavSnapshotCache(unit: DisplayUnit): boolean {
  if (readDashboardNavSnapshotCache(unit) != null) return true;
  if (unit === "usd" && readDashboardNavSnapshotCache("clp") != null) return true;
  return false;
}

/**
 * Bump when cached snapshot shape changes (v5 adds `card_metrics_by_slug`; v6 extends it
 * with the liabilities nav-tree entries — v5 caches lack them and crash the Pasivos strip;
 * v7 adds the `day` period variant + day title deltas; v8 drops `title_delta` — cards
 * render all three period rows and no title Δ chip).
 */
const STORAGE_PREFIX = "nw:dashboard-nav-snapshot-v8";
const LEGACY_STORAGE_PREFIXES = [
  "nw:dashboard-nav-snapshot-v3",
  "nw:dashboard-nav-snapshot-v4",
  "nw:dashboard-nav-snapshot-v5",
  "nw:dashboard-nav-snapshot-v6",
  "nw:dashboard-nav-snapshot-v7",
];

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

function storageKey(unit: DisplayUnit): string {
  return `${STORAGE_PREFIX}:${unit}`;
}

export function readDashboardNavSnapshotCache(
  unit: DisplayUnit
): DashboardNavSnapshotResponse | undefined {
  try {
    const raw = localStorage.getItem(storageKey(unit));
    if (!raw) return undefined;
    const snapshot = JSON.parse(raw) as DashboardNavSnapshotResponse;
    // Checked against the latest known nav tree (the sidebar-nav cache is written before a
    // fresh tree reaches any component): a snapshot that no longer covers it is discarded, so
    // every `hasDashboardNavSnapshotCache` gate flips and the live snapshot / nav context load.
    if (!navSnapshotCoversNavTree(snapshot.card_metrics_by_slug, readSidebarNavCache())) {
      localStorage.removeItem(storageKey(unit));
      return undefined;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

export function writeDashboardNavSnapshotCache(
  unit: DisplayUnit,
  snapshot: DashboardNavSnapshotResponse
): void {
  try {
    localStorage.setItem(storageKey(unit), JSON.stringify(snapshot));
    for (const prefix of LEGACY_STORAGE_PREFIXES) {
      localStorage.removeItem(`${prefix}:${unit}`);
    }
  } catch {
    // quota / private mode
  }
}
