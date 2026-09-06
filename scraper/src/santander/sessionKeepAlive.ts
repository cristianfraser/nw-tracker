import type { Page } from "playwright-core";
import { TEXT } from "./routes.js";
import { log } from "../log.js";

/** Poll interval — the prompt gives ten seconds before it logs the session out. */
const POLL_MS = 2_000;

export type SessionKeepAlive = {
  /** How many times the prompt was answered during this session. */
  readonly extensions: number;
  /** Stop polling; resolves once the loop has exited (at most one poll interval). */
  stop: () => Promise<void>;
};

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
}

/** Errors a page navigation causes in a concurrent poll — expected, not worth a log line. */
const NAVIGATION_NOISE = /context was destroyed|navigating|has been closed|Target crashed/i;

/**
 * Answer the private site's inactivity prompt for as long as the session lasts.
 *
 * Some minutes into a session the SPA overlays «Hola, vamos a cerrar tu sesión por inactividad —
 * ¿Necesitas más tiempo?» with a ten-second countdown and logs out when it expires (first seen on
 * the 2026-09-06 run, during the statement step). The scraper's own clicks do not reset that timer
 * while it sits in the step's long waits — each «Ver estado de cuenta» attempt is a 60-second wait
 * for a PDF endpoint that never answers — so a run that is merely slow would lose its session
 * mid-step. This watcher clicks «Mantener sesión» whenever the prompt is visible and never touches
 * «Cerrar sesión». It runs beside whatever step is in progress (Playwright serializes the two) and
 * stops on its own when the page goes away.
 */
export function keepSessionAlive(page: Page): SessionKeepAlive {
  let stopped = false;
  let extensions = 0;
  const loop = (async () => {
    while (!stopped && !page.isClosed()) {
      try {
        const keep = page.getByText(TEXT.keepSession).first();
        if ((await keep.count()) > 0 && (await keep.isVisible())) {
          await keep.click({ timeout: 5_000 });
          extensions += 1;
          log(`inactivity prompt answered — session kept alive (${extensions}×)`);
        }
      } catch (err) {
        if (page.isClosed()) break;
        const message = firstLine(err);
        if (!NAVIGATION_NOISE.test(message)) log(`(keep-alive: ${message})`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  })();
  return {
    get extensions() {
      return extensions;
    },
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}
