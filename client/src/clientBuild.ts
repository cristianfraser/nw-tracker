import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

/**
 * Reload an open tab onto a newer client build after a deploy.
 *
 * The server says which build it serves on the live-quotes stamp poll (`client_build`,
 * server/src/clientBuild.ts): the content-hashed `/assets/` URLs its index.html loads. This tab's
 * own build is the same URLs in the document it was loaded from, read once at boot (Vite adds
 * stylesheet links of lazy chunks later). When they differ the tab is stale, and reloads on its
 * next in-app navigation or once it is hidden — never under a form being filled. A server that
 * serves no client (the Vite dev server owns it) and the dev document state no build.
 *
 * One reload per served build (sessionStorage): if the build loaded after it still differs, the
 * tab stays and warns instead of reloading on every navigation.
 */

const RELOADED_FOR_KEY = "nw-tracker.clientBuildReloadedFor";

/** Same rule as the server's: `/assets/` URLs only, once each, sorted and space-joined. */
export function clientBuildIdFromAssetUrls(urls: readonly string[]): string | null {
  const assets = [...new Set(urls.filter((u) => u.startsWith("/assets/")))].sort();
  return assets.length === 0 ? null : assets.join(" ");
}

function ownBuildIdFromDocument(): string | null {
  if (typeof document === "undefined") return null;
  const urls: string[] = [];
  for (const s of document.querySelectorAll<HTMLScriptElement>("script[src]")) {
    urls.push(s.getAttribute("src")!);
  }
  for (const l of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')) {
    urls.push(l.getAttribute("href")!);
  }
  return clientBuildIdFromAssetUrls(urls);
}

const ownBuildId = import.meta.env.PROD ? ownBuildIdFromDocument() : null;
let staleFor: string | null = null;

function readReloadedFor(): string | null {
  try {
    return sessionStorage.getItem(RELOADED_FOR_KEY);
  } catch {
    return null;
  }
}

/** Record the build the server serves (from each stamp poll). */
export function noteServedClientBuild(served: string | null | undefined): void {
  if (ownBuildId == null || served == null || served === ownBuildId) {
    staleFor = null;
    return;
  }
  if (staleFor === served) return;
  if (readReloadedFor() === served) {
    console.warn(
      `nw-tracker: the server serves client build «${served}» but this tab still loaded «${ownBuildId}» after reloading for it; not reloading again`
    );
    return;
  }
  staleFor = served;
}

function reloadOntoServedBuild(): void {
  if (staleFor == null) return;
  try {
    sessionStorage.setItem(RELOADED_FOR_KEY, staleFor);
  } catch {
    // Without sessionStorage the guard against a reload loop is lost; reloading is still right.
  }
  window.location.reload();
}

/** Mount once inside the router: reloads a stale tab on navigation or when it is hidden. */
export function useReloadOnNewClientBuild(): void {
  const location = useLocation();
  const current = `${location.pathname}${location.search}`;
  const previous = useRef(current);
  useEffect(() => {
    if (previous.current === current) return;
    previous.current = current;
    reloadOntoServedBuild();
  }, [current]);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") reloadOntoServedBuild();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
}
