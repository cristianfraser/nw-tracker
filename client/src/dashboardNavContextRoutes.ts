/**
 * Routes that render portfolio nav cards backed by `GET /api/dashboard/nav-context`.
 * Home uses `page-bundle`; account detail loads nav-context only when showing child cards.
 */
export function pathnameUsesDashboardNavContext(pathname: string): boolean {
  if (pathname === "/") return false;
  if (pathname.startsWith("/account/")) return false;
  if (pathname.startsWith("/flows")) return false;
  if (pathname.startsWith("/rates")) return false;
  if (pathname.startsWith("/panel")) return false;
  return true;
}
