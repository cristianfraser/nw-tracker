import type { QueryClient } from "@tanstack/react-query";
import {
  findBestNavNodeForPathname,
  findNavTreeNodeByAccountId,
  resolveGroupPageApiParams,
} from "../portfolioNavFromApi";
import type { NavTreeNodeDto, SidebarNavResponse } from "../types";
import {
  prefetchAccountDetailBundle,
  prefetchAccountsByPortfolioGroup,
  prefetchDashboardNavSnapshot,
} from "./displayUnitQueries";
import type { DisplayUnit } from "./keys";

const NET_WORTH_PORTFOLIO_GROUP = "net_worth";

function normalizePath(path: string): string {
  const t = path.trim();
  if (!t || t === "/") return "/";
  return t.endsWith("/") ? t.slice(0, -1) : t;
}

function findNavNodeDtoForPath(
  payload: SidebarNavResponse,
  pathname: string
): NavTreeNodeDto | null {
  const roots: NavTreeNodeDto[] = [];
  if (payload.net_worth) roots.push(payload.net_worth);
  roots.push(...payload.main);
  for (const root of roots) {
    const hit = findBestNavNodeForPathname([root], pathname);
    if (hit) return hit;
  }
  const accountMatch = /^\/account\/(\d+)\/?$/.exec(normalizePath(pathname));
  if (accountMatch) {
    const id = Number(accountMatch[1]);
    if (Number.isFinite(id) && id > 0) {
      return findNavTreeNodeByAccountId(payload.main, id);
    }
  }
  return null;
}

/**
 * Prefetch page shape on sidebar hover.
 * Groups → `GET /api/accounts?portfolio_group=<slug>`; accounts → detail bundle; home → nav-snapshot.
 */
export function prefetchPageShapeForPath(
  queryClient: QueryClient,
  unit: DisplayUnit,
  payload: SidebarNavResponse,
  targetPath: string
): void {
  const path = normalizePath(targetPath);

  if (path.startsWith("/flows") || path.startsWith("/rates") || path.startsWith("/panel")) {
    return;
  }

  if (path === "/") {
    void prefetchDashboardNavSnapshot(queryClient, unit);
    void prefetchAccountsByPortfolioGroup(queryClient, NET_WORTH_PORTFOLIO_GROUP, unit);
    return;
  }

  const accountMatch = /^\/account\/(\d+)$/.exec(path);
  if (accountMatch) {
    const id = Number(accountMatch[1]);
    if (Number.isFinite(id) && id > 0) {
      void prefetchAccountDetailBundle(queryClient, id, unit);
    }
    return;
  }

  const navNode = findNavNodeDtoForPath(payload, path);
  if (!navNode) return;

  const apiParams = resolveGroupPageApiParams(navNode);
  if (!apiParams?.portfolio_group) return;

  void prefetchAccountsByPortfolioGroup(queryClient, apiParams.portfolio_group, unit);
  void prefetchDashboardNavSnapshot(queryClient, unit);
}
