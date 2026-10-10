import fs from "node:fs";
import path from "node:path";
import type { Download, Page } from "playwright-core";
import type { ApiCall, Recorder } from "./capture.js";
import { ensureDir } from "./paths.js";
import { log } from "./log.js";

/** Let the SPA settle after a route change. A busy network is normal here, so a timeout is not an error. */
export async function settle(page: Page, timeoutMs = 8_000): Promise<void> {
  try {
    await page.waitForLoadState("networkidle", { timeout: timeoutMs });
  } catch {
    log("(network still busy — continuing)");
  }
}

/**
 * Which recorded calls a wait counts: an endpoint basename (exact), a pattern over the basename,
 * or a predicate over the whole call (request body included — the checking step waits for the
 * transactions call that names the PESO account, not just any transactions call).
 */
export type ApiCallMatcher = string | RegExp | ((call: ApiCall) => boolean);

export function matchesApiCall(call: ApiCall, matcher: ApiCallMatcher): boolean {
  if (typeof matcher === "string") return call.endpoint === matcher;
  if (matcher instanceof RegExp) return matcher.test(call.endpoint);
  return matcher(call);
}

export function countApiCalls(calls: readonly ApiCall[], matcher: ApiCallMatcher): number {
  return calls.filter((call) => matchesApiCall(call, matcher)).length;
}

/**
 * Block until the recorder sees more calls matching `matcher` than `baselineCount`.
 *
 * This is the one wait the steps use after a navigation, a tab click or a carousel move: the
 * SPA never reaches `networkidle` (analytics traffic keeps flowing), so waiting for the data call
 * the view makes is both faster and the proof that the view loaded.
 */
export async function waitForNewApiCalls(
  recorder: Recorder,
  matcher: ApiCallMatcher,
  baselineCount: number,
  timeoutMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (countApiCalls(recorder.calls, matcher) > baselineCount) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

type InlineDownload = { name: string; href: string };

/** `data:<mime>;base64,<payload>` (or a percent-encoded payload) → bytes. */
export function decodeDataUrl(href: string): Buffer {
  const m = /^data:([^,]*?)(;base64)?,([\s\S]*)$/.exec(href);
  if (!m) throw new Error(`Not a data: URL (${href.slice(0, 40)}…)`);
  return m[2] ? Buffer.from(m[3]!, "base64") : Buffer.from(decodeURIComponent(m[3]!), "utf8");
}

type CapturedDownload =
  | { kind: "inline"; name: string; bytes: Buffer }
  | { kind: "native"; name: string; download: Download };

/**
 * Run `trigger` and save the resulting download.
 *
 * Two ways a file can arrive, raced: a file the page builds itself lands on
 * `window.__nwInlineDownloads` (the init script in browser.ts keeps such data:/blob: anchor
 * clicks away from Chrome's downloader, which Chrome 152 crashes in) and is written from those
 * bytes; a real HTTP download still comes through Playwright's download event and `saveAs`.
 *
 * The bank's own filename is preserved on purpose: `import:cfraser-inbox` identifies documents by
 * it (`80_<seq>_<account>_YYYYMMDD.pdf` = card statement, `1_…_CC.pdf` = cuenta corriente cartola,
 * `ultimos movimientos-Cuenta Corriente.xlsx` = the daily checking feed). Renaming here would
 * silently break the downstream organizer, and a file without a name is refused for the same reason.
 */
export async function downloadTo(
  page: Page,
  destDir: string,
  trigger: () => Promise<void>,
  timeoutMs = 90_000,
): Promise<string> {
  const inline: Promise<CapturedDownload> = page
    .waitForFunction(
      () => ((window as unknown as { __nwInlineDownloads?: unknown[] }).__nwInlineDownloads?.length ?? 0) > 0,
      null,
      { timeout: timeoutMs },
    )
    .then(async () => {
      const entry = await page.evaluate(
        () => (window as unknown as { __nwInlineDownloads: InlineDownload[] }).__nwInlineDownloads.shift()!,
      );
      return { kind: "inline" as const, name: entry.name, bytes: decodeDataUrl(entry.href) };
    });
  const native: Promise<CapturedDownload> = page
    .waitForEvent("download", { timeout: timeoutMs })
    .then((download) => ({ kind: "native" as const, name: download.suggestedFilename(), download }));
  // Whichever loses keeps waiting until its own timeout; its rejection must never surface.
  inline.catch(() => undefined);
  native.catch(() => undefined);

  const [captured] = await Promise.all([Promise.any([inline, native]), trigger()]);
  if (!captured.name) {
    throw new Error("Download carries no filename — the organizer needs the bank's own name");
  }
  const dest = path.join(ensureDir(destDir), captured.name);
  if (captured.kind === "inline") {
    fs.writeFileSync(dest, captured.bytes);
    log(`saved ${path.basename(dest)} (${captured.bytes.length} bytes, built by the page — Chrome's downloader bypassed)`);
  } else {
    await captured.download.saveAs(dest);
    log(`saved ${path.basename(dest)}`);
  }
  return dest;
}
