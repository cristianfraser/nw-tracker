import type { Frame, Locator, Page } from "playwright-core";
import { saveClaveUnicaDiagnostics } from "./claveUnica/login.js";
import { log } from "./log.js";

/**
 * Dialogs, modals and overlays a portal opens over its page (a marketing notice, a «we updated
 * our terms» note): closed through their OWN close control before a navigation or a click, never
 * by clicking an arbitrary button — a dialog's other buttons may accept, confirm or buy. Each
 * dismissal is logged with a screenshot (`cfraser/scraper-diagnostics/`), so a run that met a new
 * overlay says so. An overlay that still covers the page afterwards fails the run with a
 * screenshot instead of a click that lands on it. The decisions are pure, below.
 */

/** What an overlay is, as the page marks it. */
export const OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',
  ".modal.show",
  ".modal.in",
  ".mat-dialog-container",
  ".mat-mdc-dialog-container",
  ".swal2-popup",
].join(", ");

const CONTROL_SELECTOR = 'button, a, [role="button"], [aria-label], .close, .btn-close';

/** A control as read from the page. */
export type OverlayControl = { text: string; ariaLabel: string | null; title: string | null; className: string | null };

const CLOSE_LABEL = /^(cerrar|close|dismiss|ocultar)(\s+(modal|ventana|aviso|di[aá]logo|dialog|popup|mensaje|notificaci[oó]n))?$/i;
const CLOSE_TEXT = /^(×|✕|✖|x|cerrar|close|entendido|ahora no)$/i;
const CLOSE_CLASS = /(^|[\s_-])(close|btn-close|modal-close|dialog-close|close-button|closebutton)($|[\s_-])/i;
const GLYPH_OR_EMPTY = /^(×|✕|✖|x)?$/i;

function squash(s: string | null): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** Whether a control only closes its overlay: a close label, a close word or ×, or a close class with no other text. */
export function isCloseControl(c: OverlayControl): boolean {
  const label = squash(c.ariaLabel) || squash(c.title);
  if (label) return CLOSE_LABEL.test(label);
  const text = squash(c.text);
  if (CLOSE_TEXT.test(text)) return true;
  return CLOSE_CLASS.test(c.className ?? "") && GLYPH_OR_EMPTY.test(text);
}

export type Box = { x: number; y: number; width: number; height: number };

/** An overlay blocks the page when it covers the viewport's centre or 40% of it (a corner toast does not). */
export function overlayBlocks(box: Box, viewport: { width: number; height: number }): boolean {
  if (box.width <= 0 || box.height <= 0) return false;
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  if (box.x <= cx && cx <= box.x + box.width && box.y <= cy && cy <= box.y + box.height) return true;
  const w = Math.max(0, Math.min(box.x + box.width, viewport.width) - Math.max(box.x, 0));
  const h = Math.max(0, Math.min(box.y + box.height, viewport.height) - Math.max(box.y, 0));
  return w * h >= 0.4 * viewport.width * viewport.height;
}

const MAX_DISMISSALS = 5;

async function describeControl(el: Locator): Promise<OverlayControl> {
  return {
    text: (await el.innerText({ timeout: 2_000 }).catch(() => "")) ?? "",
    ariaLabel: await el.getAttribute("aria-label", { timeout: 2_000 }).catch(() => null),
    title: await el.getAttribute("title", { timeout: 2_000 }).catch(() => null),
    className: await el.getAttribute("class", { timeout: 2_000 }).catch(() => null),
  };
}

function overlayTitle(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !CLOSE_TEXT.test(l))
      ?.slice(0, 80) ?? ""
  );
}

async function blockingOverlays(page: Page): Promise<{ frame: Frame; overlay: Locator }[]> {
  const viewport = page.viewportSize() ?? (await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })).catch(() => ({ width: 1280, height: 800 })));
  const found: { frame: Frame; overlay: Locator }[] = [];
  for (const frame of page.frames()) {
    try {
      const all = frame.locator(OVERLAY_SELECTOR);
      const n = await all.count();
      for (let i = 0; i < n; i++) {
        const o = all.nth(i);
        if (!(await o.isVisible().catch(() => false))) continue;
        const box = await o.boundingBox({ timeout: 2_000 }).catch(() => null);
        if (box && overlayBlocks(box, viewport)) found.push({ frame, overlay: o });
      }
    } catch {
      // detached frame
    }
  }
  return found;
}

/** The overlay's first visible close control, or null. */
async function closeControlOf(overlay: Locator): Promise<{ el: Locator; c: OverlayControl } | null> {
  const controls = overlay.locator(CONTROL_SELECTOR);
  const n = await controls.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = controls.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const c = await describeControl(el);
    if (isCloseControl(c)) return { el, c };
  }
  return null;
}

/**
 * Close every overlay covering `page` through its own close control; throw (with a screenshot)
 * when one still covers it. `label` names the site in the log, `tag` the diagnostics files.
 */
export async function dismissOverlays(page: Page, label: string, tag: string): Promise<void> {
  for (let round = 0; round <= MAX_DISMISSALS; round++) {
    const blocking = await blockingOverlays(page);
    if (blocking.length === 0) return;
    if (round === MAX_DISMISSALS) break;
    let closed = false;
    for (const { overlay } of blocking) {
      const control = await closeControlOf(overlay);
      if (!control) continue;
      const title = overlayTitle(await overlay.innerText({ timeout: 2_000 }).catch(() => ""));
      const named = squash(control.c.ariaLabel) || squash(control.c.title) || squash(control.c.text) || "close";
      const shot = await saveClaveUnicaDiagnostics(page, `${tag}-overlay`);
      await control.el.click({ timeout: 10_000 });
      log(`${label}: closed an overlay${title ? ` («${title}»)` : ""} with «${named}» (${shot})`);
      closed = true;
      await page.waitForTimeout(500);
      break;
    }
    if (!closed) break;
  }
  const remaining = await blockingOverlays(page);
  if (remaining.length === 0) return;
  const title = overlayTitle(await remaining[0]!.overlay.innerText({ timeout: 2_000 }).catch(() => ""));
  throw new Error(`${label}: an overlay${title ? ` («${title}»)` : ""} covers the page and has no close control (${await saveClaveUnicaDiagnostics(page, `${tag}-overlay-blocks`)})`);
}

/** Close any overlay, then click. */
export async function clickPastOverlays(page: Page, target: Locator, label: string, tag: string): Promise<void> {
  await dismissOverlays(page, label, tag);
  await target.click({ timeout: 10_000 });
}
