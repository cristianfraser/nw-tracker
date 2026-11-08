/**
 * Where the dashboard lives. Every build serves it at `/dashboard`; a personal instance also at
 * `/` (its home), while the hosted demo's `/` is the About page (docs/demo-about-plan.md).
 */
export const DEMO_BUILD = import.meta.env.VITE_DEMO_MODE === "1";

export const DASHBOARD_ALIAS_PATH = "/dashboard";

/** The address links to the dashboard use in this build. */
export const DASHBOARD_PATH = DEMO_BUILD ? DASHBOARD_ALIAS_PATH : "/";

/** Whether a pathname shows the dashboard in this build. */
export function isDashboardPathname(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  return p === DASHBOARD_ALIAS_PATH || (!DEMO_BUILD && p === "/");
}
