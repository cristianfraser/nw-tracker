import { createContext, useContext } from "react";

/**
 * True while the dashboard is drawn only as far as the first screen: the demo's About page shows
 * it as a tilted preview, and the tiles below the fold are left out until it has moved into place
 * (DemoHomePage). Everywhere else it is false and the whole page renders.
 */
export const DashboardFoldOnlyContext = createContext(false);

export function useDashboardFoldOnly(): boolean {
  return useContext(DashboardFoldOnlyContext);
}
