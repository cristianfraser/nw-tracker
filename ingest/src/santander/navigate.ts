import type { Page } from "playwright-core";
import { APP_BASE } from "./routes.js";

/**
 * Open a private-app route. Hash-only changes don't reload the document, so the hash is set
 * in-page; from anywhere else the app is loaded with the route in its hash.
 *
 * Deliberately no wait of its own: the SPA keeps analytics traffic flowing, so `networkidle` never
 * arrives and the settle this used to carry (`gotoRoute`, until 2026-10-10) only ever ran to its
 * timeout. Every caller waits for the view's own data call instead (`waitForNewApiCalls`), which is
 * both faster and the proof that the view loaded.
 */
export async function openRoute(page: Page, route: string): Promise<void> {
  if (page.url().startsWith(APP_BASE)) {
    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, route);
  } else {
    await page.goto(`${APP_BASE}#${route}`, { waitUntil: "domcontentloaded" });
  }
}
