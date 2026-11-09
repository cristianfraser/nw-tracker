import { createContext, useContext } from "react";

/**
 * How much of the dashboard is drawn below its first screen (the demo's About page shows it as a
 * tilted preview, DemoHomePage):
 * - `cut`: not rendered (About before the browser is idle);
 * - `hidden`: rendered and laid out, but invisible and inert, and the tiles' own queries are off
 *   (About once idle, and the move in) — the move ends with no rendering and no layout change;
 * - `full`: the whole page, everywhere else.
 */
export type DashboardFold = "full" | "hidden" | "cut";

export const DashboardFoldContext = createContext<DashboardFold>("full");

export function useDashboardFold(): DashboardFold {
  return useContext(DashboardFoldContext);
}

/**
 * True inside the part of a page that is rendered but hidden below the fold (`GroupInfoBase`
 * provides it): a `PageGridTile` there is invisible and inert.
 */
export const BelowFoldHiddenContext = createContext(false);

/**
 * True while the dashboard is the About page's tilted preview (not on /dashboard itself): the
 * net-worth lines then draw in slowly the first time (DashboardPage); a direct load draws them at
 * the usual speed.
 */
export const DashboardAboutPreviewContext = createContext(false);

export function useDashboardAboutPreview(): boolean {
  return useContext(DashboardAboutPreviewContext);
}
