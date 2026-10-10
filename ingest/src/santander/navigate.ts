import type { Page } from "playwright-core";
import { APP_BASE } from "./routes.js";

/**
 * Open a private-app route without waiting for `networkidle`.
 *
 * The same hash navigation as `gotoRoute` (login.ts), minus its `settle()`: the SPA keeps
 * analytics traffic flowing, so `networkidle` never arrives and the settle only ever ran to its
 * timeout (run 268: every one of them). A step that opens a route this way waits for the view's
 * own data call instead (`waitForNewApiCalls`), which is both faster and the proof it loaded.
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
