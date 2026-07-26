import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { applyFavicon, type FaviconSpec } from "./favicon";
import { rgbTripletToHex } from "./chartColors";
import { findBestNavNodeForPathname } from "./portfolioNavFromApi";
import { useSidebarNav } from "./queries/hooks";
import type { NavTreeNodeDto } from "./types";

const WHITE = "#ffffff";
const DEPOSITS_LIGHT_BLUE = "#38bdf8";
const EXPENSES_RED = "#ef4444";
const FLOWS_GREEN = "#22c55e";
const SETTINGS_GRAY = "#94a3b8";

/**
 * Fixed-icon routes, most-specific first (matched as exact path or path prefix), so
 * subroutes inherit their section's icon (`/flows/deposits/reconciliation`,
 * `/flows/expenses/real_estate/…`). `/flows` itself must stay after its subroutes.
 */
const STATIC_ROUTE_SPECS: [prefix: string, spec: FaviconSpec][] = [
  ["/flows/deposits", { kind: "triangle", direction: "up", color: DEPOSITS_LIGHT_BLUE }],
  ["/flows/expenses", { kind: "triangle", direction: "down", color: EXPENSES_RED }],
  ["/flows/income", { kind: "triangle", direction: "down", color: FLOWS_GREEN }],
  ["/flows/pl", { kind: "triangle", direction: "up", color: FLOWS_GREEN }],
  ["/flows", { kind: "triangle", direction: "up", color: WHITE }],
  ["/wealth-percentile", { kind: "corner-square", color: WHITE }],
  ["/projections", { kind: "triangle", direction: "up-right", color: WHITE }],
  ["/panel/settings", { kind: "circle", color: SETTINGS_GRAY }],
];

/**
 * Icon for a pathname: fixed table first; otherwise bucket/account routes resolve
 * through the nav tree — nodes carry a server-resolved `color_rgb` (explicit DB color
 * or the charts' fallback), so the diagonal half always matches the page's chart Total.
 * Unmatched routes (home, rates, watchlist, other panel pages) keep the plain square.
 */
export function faviconSpecForRoute(
  pathname: string,
  navMain: NavTreeNodeDto[] | undefined
): FaviconSpec {
  const path = pathname.replace(/\/+$/, "") || "/";
  for (const [prefix, spec] of STATIC_ROUTE_SPECS) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return spec;
  }
  const node = findBestNavNodeForPathname(navMain, path);
  if (node?.color_rgb) return { kind: "diagonal", color: rgbTripletToHex(node.color_rgb) };
  return { kind: "plain" };
}

/** Keeps the favicon in sync with the current route (mounted once in `AppTree`). */
export function useFaviconFromRoute(): void {
  const { pathname } = useLocation();
  const { data: sidebarNav } = useSidebarNav();

  useEffect(() => {
    applyFavicon(faviconSpecForRoute(pathname, sidebarNav?.main));
  }, [pathname, sidebarNav]);
}
