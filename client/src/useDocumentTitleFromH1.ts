import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/** App name — the suffix, and the whole title when a page renders no `h1`. */
export const BASE_DOCUMENT_TITLE = "NW Tracker";

/**
 * Tab title for a page's `h1` text, suffixed with the app name. Whitespace is collapsed
 * because the heading may wrap nested nodes; an empty/absent heading leaves the app name
 * alone rather than a bare separator.
 */
export function documentTitleFromH1Text(raw: string | null | undefined): string {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  return text.length > 0 ? `${text} · ${BASE_DOCUMENT_TITLE}` : BASE_DOCUMENT_TITLE;
}

/**
 * Heading selectors for a route, best first.
 *
 * Flows subpages share one `h1` ("Flujos") on their layout and carry their own name in the
 * `h2` section title, so keying on the `h1` alone made every one of them read "Flujos".
 * The index route is deliberately not a subroute here: its `h2` says "Resumen", and the
 * layout's "Flujos" is the better tab title for it.
 *
 * Panel subpages share an `h1` the same way, but their `h2`s are section titles inside the
 * page ("Añadir cuenta", "Log de sincronización") and two subpages have none at all — so
 * the page's name is taken from its own subnav tab instead, which is the label
 * PANEL_SUBROUTES already drives.
 */
export function pageHeadingSelectors(pathname: string): string[] {
  const path = pathname.replace(/\/+$/, "");
  if (path.startsWith("/flows/")) return ["h2.flow-section-title", "h1"];
  if (path.startsWith("/panel/")) return ["nav.flow-subnav a.active", "h1"];
  return ["h1"];
}

/**
 * Keeps `document.title` in sync with the current page's heading.
 *
 * A route change alone is not enough of a signal: pages render their heading after the
 * lazy chunk loads and (account/group pages) after the name arrives from the API, and the
 * text itself changes on a language switch. So a MutationObserver watches the tree and
 * re-reads the heading — the route is also a dependency so a page without a heading resets
 * the title instead of keeping the previous page's.
 */
export function useDocumentTitleFromH1(): void {
  const { pathname } = useLocation();

  useEffect(() => {
    const selectors = pageHeadingSelectors(pathname);
    const sync = () => {
      const heading = selectors.reduce<Element | null>(
        (found, selector) => found ?? document.querySelector(selector),
        null
      );
      const next = documentTitleFromH1Text(heading?.textContent);
      // Assigning an unchanged title is a no-op in browsers, but skipping it keeps this
      // observer from feeding itself in environments that mutate the DOM on write.
      if (document.title !== next) document.title = next;
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, [pathname]);
}
