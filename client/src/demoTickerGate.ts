import { useSyncExternalStore } from "react";

/**
 * The demo's About page holds the market ticker back: it is not shown on `/`, and when the
 * visitor opens the dashboard it mounts (with its normal slide-in) only once the dashboard has
 * finished moving into place. DemoHomePage reports the move; the app shell reads it.
 */
let dashboardMovingIn = false;
const listeners = new Set<() => void>();

export function setDemoDashboardMovingIn(moving: boolean): void {
  if (dashboardMovingIn === moving) return;
  dashboardMovingIn = moving;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while the demo's dashboard is moving in from About. */
export function useDemoDashboardMovingIn(): boolean {
  return useSyncExternalStore(subscribe, () => dashboardMovingIn);
}
