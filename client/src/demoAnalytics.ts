import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * Pageview beacon for the hosted demo's anonymous analytics (server: demoAnalytics.ts).
 *
 * The server only ever sees the initial document request — every in-app navigation is a
 * client-side route change — so without this a visitor who explores ten pages is
 * indistinguishable from one who bounced off the dashboard.
 *
 * No gating is needed for local personal mode: the endpoint is registered in demo mode only,
 * and `sendBeacon` is fire-and-forget (a 404 is never surfaced).
 */

const BEACON_PATH = "/api/demo/pageview";
/** Campaign tag from the landing URL (?src=linkedin|cv|homepage), kept for the whole visit. */
const SRC_STORAGE_KEY = "nw:demo-src";

function captureSrcTag(): string | null {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("src");
    if (fromUrl) sessionStorage.setItem(SRC_STORAGE_KEY, fromUrl);
    return sessionStorage.getItem(SRC_STORAGE_KEY);
  } catch {
    // Private-mode sessionStorage can throw; the tag is a nice-to-have, the pageview isn't.
    return null;
  }
}

function sendPageview(path: string): void {
  const payload = JSON.stringify({ path, src: captureSrcTag() });
  const blob = new Blob([payload], { type: "application/json" });
  if (navigator.sendBeacon?.(BEACON_PATH, blob)) return;
  void fetch(BEACON_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {
    /* analytics must never surface an error to the user */
  });
}

/** Reports the current route on mount and on every subsequent navigation. */
export function useDemoPageviewBeacon(): void {
  const { pathname } = useLocation();
  useEffect(() => {
    sendPageview(pathname);
  }, [pathname]);
}
