/** Page paths as the usage log stores them (`usage_page_views`); a leaf so the DB setup can use it. */

/** The page-view beacon — a POST, and the one mutation the read-only demo accepts. */
export const USAGE_PAGE_VIEW_PATH = "/api/usage/page-view";

const MAX_PATH = 200;

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
