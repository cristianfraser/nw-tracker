import i18n from "./i18n";
import { mutedPillBackgroundRgb, parseRgbTriplet } from "./chartColors";
import { EXPENSES_FAVICON_SPEC, EXPENSES_ROUTE } from "./favicon";
import type { NavTreeNodeDto, SidebarNavResponse } from "./types";
import { sortNavTreeLeavesFirst, type SidebarNavMarker, type SidebarNavNode } from "./sidebarNavTree";

/**
 * Label keys the SERVER emits via `label_i18n_key` (seedNavTree.ts and friends),
 * resolved dynamically by resolveNavTreeLabel below. Listed as literals so the
 * key-integrity test (i18n/keyIntegrity.test.ts) sees the locale keys reachable;
 * `sidebarNavLabelKeys.test.ts` checks it against the server's sources and master.json.
 */
export const SERVER_NAV_LABEL_I18N_KEYS = [
  "dashboard.buckets.cash_eqs",
  "dashboard.buckets.cash_savings",
  "dashboard.buckets.real_estate",
  "dashboard.cards.brokerage",
  "dashboard.cards.liabilities",
  "dashboard.cards.netWorth",
  "dashboard.cards.retirement",
  "liabilities.creditCard",
  "liabilities.mortgage",
  "liabilities.ref.disponible",
  "liabilities.ref.disponibleTotal",
  "marketTicker.uf",
  "marketTicker.usdLive",
  "retirement.afpAfc",
  "retirement.apv",
  "sidebar.checking_accounts",
  "sidebar.flows",
  "sidebar.flowsDeposits",
  "sidebar.flowsExpenses",
  "sidebar.flowsExpensesGroceries",
  "sidebar.flowsExpensesRealEstate",
  "sidebar.flowsIncome",
  "sidebar.flowsPl",
  "sidebar.inversiones",
  "sidebar.projections",
  "sidebar.rates",
  "sidebar.taxReturn",
  "sidebar.wealthPercentile",
  "sidebar.watchlist",
  "watchlist.riskyNorrisProxy",
] as const;

export function resolveNavTreeLabel(dto: Pick<NavTreeNodeDto, "label" | "label_i18n_key">): string {
  if (dto.label_i18n_key) {
    const translated = i18n.t(dto.label_i18n_key);
    if (translated !== dto.label_i18n_key) return translated;
  }
  return dto.label;
}

/** Inactive buckets stay in the payload for group pages; the sidebar and subnav tabs hide them. */
export function visibleNavChildren(dtos: NavTreeNodeDto[]): NavTreeNodeDto[] {
  return dtos.filter((c) => c.chart_inactive !== true);
}

/**
 * A row's mark: the expenses row shows its favicon's triangle; under the net-worth sections a group
 * with rows under it (`group`) its colour square, in its card pill's colour.
 */
function navNodeMarker(dto: NavTreeNodeDto, group: boolean): SidebarNavMarker | undefined {
  if (dto.route_path === EXPENSES_ROUTE) return { shape: "triangle-down", color: EXPENSES_FAVICON_SPEC.color };
  if (!group || dto.account_id != null || dto.expense_account_id != null) return undefined;
  const rgb = parseRgbTriplet(dto.color_rgb);
  return rgb ? { shape: "square", color: mutedPillBackgroundRgb(rgb) } : undefined;
}

/**
 * `asLeaf`: a sub-bucket listed beside accounts (Portafolio IPSA among Acciones' stocks) shows
 * as one entry in the seeded order, not expanded — its accounts are on its own page.
 * `markers`: under the net-worth sections, a group with rows under it (the rows that show a chevron)
 * carries its colour square; a sub-bucket shown as a leaf does not.
 */
function mapNode(dto: NavTreeNodeDto, asLeaf = false, markers = false): SidebarNavNode {
  const visible = asLeaf ? [] : visibleNavChildren(dto.children);
  const mixed =
    visible.some((c) => c.account_id != null) && visible.some((c) => c.account_id == null);
  const childDtos =
    visible.length === 0
      ? undefined
      : mixed
        ? visible.map((c) => mapNode(c, c.account_id == null, markers))
        : sortNavTreeLeavesFirst(visible).map((c) => mapNode(c, false, markers));
  const children = childDtos && childDtos.length > 0 ? childDtos : undefined;
  return {
    id: dto.node_id,
    label: resolveNavTreeLabel(dto),
    to: dto.route_path,
    end: dto.nav_end ? true : undefined,
    activePrefix: dto.active_prefix ?? undefined,
    marker: navNodeMarker(dto, markers && children != null),
    children,
  };
}

/** Build sidebar nodes from `GET /api/meta/sidebar-nav` (same layout sections as legacy builder). */
export function buildSidebarNavFromApi(payload: SidebarNavResponse): SidebarNavNode[] {
  const out: SidebarNavNode[] = [];
  if (payload.dashboard) {
    out.push({ ...mapNode(payload.dashboard), label: i18n.t("sidebar.dashboard") });
  }
  for (const n of visibleNavChildren(payload.main)) out.push(mapNode(n, false, true));
  if (payload.projections) out.push(mapNode(payload.projections));
  if (payload.wealth_percentile) out.push(mapNode(payload.wealth_percentile));
  if (payload.tax_return) out.push(mapNode(payload.tax_return));
  if (payload.flows) out.push(mapNode(payload.flows));
  if (payload.rates) out.push(mapNode(payload.rates));
  return out;
}
