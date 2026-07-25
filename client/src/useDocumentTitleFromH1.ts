import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/** Title when a page renders no `h1` (e.g. the dashboard) — matches index.html. */
export const BASE_DOCUMENT_TITLE = "NW Tracker";

/**
 * Tab title for a page's `h1` text. Whitespace is collapsed because the heading may
 * wrap nested nodes; an empty/absent heading falls back to the app name.
 */
export function documentTitleFromH1Text(raw: string | null | undefined): string {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : BASE_DOCUMENT_TITLE;
}

/**
 * Keeps `document.title` in sync with the current page's `h1`.
 *
 * A route change alone is not enough of a signal: pages render their heading after the
 * lazy chunk loads and (account/group pages) after the name arrives from the API, and the
 * text itself changes on a language switch. So a MutationObserver watches the tree and
 * re-reads the heading — the route is only a dependency so a page without an `h1` resets
 * the title instead of keeping the previous page's.
 */
export function useDocumentTitleFromH1(): void {
  const { pathname } = useLocation();

  useEffect(() => {
    const sync = () => {
      const next = documentTitleFromH1Text(document.querySelector("h1")?.textContent);
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
