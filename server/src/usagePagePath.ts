/** Page paths as the usage log stores them (`usage_page_views`); a leaf so the DB setup can use it. */

/** The page-view beacon — a POST, and the one mutation the read-only demo accepts (shared with the client). */
export { USAGE_PAGE_VIEW_PATH } from "nw-tracker-contracts/dto/apiConstants";

const MAX_PATH = 200;

/** The route a view of a page that found nothing is recorded under; `path` keeps where it was. */
export const USAGE_NOT_FOUND_ROUTE = "/404";

/** A client route for grouping page views: numeric path segments become `:id`. */
export function usagePageRoute(path: string): string {
  return path
    .split("/")
    .map((segment) => (/^\d+$/.test(segment) ? ":id" : segment))
    .join("/");
}

/**
 * A beacon path as an app route: leading slash, no query/hash, bounded. Null otherwise — the
 * beacon is unauthenticated on the public demo, so anything else is not recorded.
 */
export function normalizeUsagePagePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.split(/[?#]/)[0]?.trim() ?? "";
  if (!path.startsWith("/") || path.startsWith("//") || path.length > MAX_PATH) return null;
  return path;
}
