import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BrowserContext, Frame, Page } from "playwright-core";
import { firstPage, launchBrowser } from "../browser.js";
import { Recorder, runStampNow } from "../capture.js";
import { loadBankConfig } from "../config.js";
import { readKeychainSecret } from "../keychain.js";
import { log } from "../log.js";
import { assertRunAllowed } from "../runGuard.js";
import { assertValidSteps } from "../steps.js";
import type { RunOptions } from "../runTypes.js";
import { decodeDataUrl } from "../wait.js";

/**
 * AFP UNO's private site — first, SUPERVISED capture run. Nothing about the site is known yet
 * (login page, the «últimos movimientos» table, how the two certificates are generated), so this
 * run reads nothing and parses nothing: it signs in when it can find the form, then records while
 * the user clicks through by hand —
 *
 *   - every XHR/fetch call (the Recorder; the clave is redacted from anything written),
 *   - a screenshot plus the page's text and every table's cells whenever a page loads or its text
 *     changes (an SPA renders the table without a navigation),
 *   - every file the site hands over: a real download, a file the page builds itself (data:/blob:
 *     anchors, kept by browser.ts's init script), or a PDF opened in a tab.
 *
 * Everything lands in `cfraser/afp-uno-captures/<stamp>/`. The run ends when the user closes the
 * window, or after `CAPTURE_MINUTES`. The nightly fetch is built from what it shows.
 *
 * The login form is filled from `cfraser/afp-uno-fetch.json` (the RUT) and the Keychain item
 * `nw-tracker-afp-uno` (the clave). A captcha is never worked around: if the site shows one, or the
 * form is not found, the user signs in by hand in the open window.
 */

const BANK = "afp-uno" as const;
const START_URL = "https://www.uno.cl/";
const CAPTURE_MINUTES = 25;
/** How often the open pages are checked for new text (an SPA re-render) and new page-built files. */
const POLL_MS = 3_000;
/** Links that lead to the private site's sign-in form. */
const LOGIN_LINK = /ingres|iniciar sesi|acceso|mi cuenta|sucursal virtual|clientes/i;

type PageState = { lastTextHash: string | null };

function sha1(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function safeLabel(raw: string): string {
  const cleaned = raw.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 70);
  return cleaned || "page";
}

/** Text and every table (rows of cell texts) of one frame. */
async function frameSnapshot(frame: Frame): Promise<{ url: string; text: string; tables: string[][][] }> {
  return frame.evaluate(() => {
    const tables = Array.from(document.querySelectorAll("table")).map((t) =>
      Array.from(t.querySelectorAll("tr")).map((tr) =>
        Array.from(tr.querySelectorAll("th,td")).map((c) => (c as HTMLElement).innerText.replace(/\s+/g, " ").trim())
      )
    );
    return { url: location.href, text: (document.body?.innerText ?? "").slice(0, 200_000), tables };
  });
}

class AfpUnoCaptureSession {
  private seq = 0;
  private readonly states = new WeakMap<Page, PageState>();
  private readonly saved = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly recorder: Recorder,
    private readonly secrets: string[]
  ) {}

  private next(label: string): string {
    this.seq += 1;
    return path.join(this.dir, `p${String(this.seq).padStart(3, "0")}-${label}`);
  }

  /** The clave never reaches a file. */
  private redact(text: string): string {
    return this.secrets.reduce((t, s) => (s ? t.split(s).join("«redacted»") : t), text);
  }

  watch(page: Page): void {
    if (this.states.has(page)) return;
    this.states.set(page, { lastTextHash: null });
    this.recorder.attach(page);
    page.on("load", () => void this.snapshot(page, "load"));
    page.on("download", (download) => {
      void (async () => {
        const file = this.next(`download-${safeLabel(download.suggestedFilename())}`);
        await download.saveAs(file);
        log(`saved download ${path.basename(file)}`);
      })().catch((err: unknown) => log(`download not saved: ${String(err)}`));
    });
    // A certificate opened in a tab (Chrome's PDF viewer) is a document response, not a download.
    page.on("response", (response) => {
      const type = response.headers()["content-type"] ?? "";
      if (!/application\/pdf/i.test(type)) return;
      void (async () => {
        const body = await response.body();
        const key = sha1(body.toString("base64"));
        if (this.saved.has(key)) return;
        this.saved.add(key);
        const name = safeLabel(response.url().split("?")[0]!.split("/").pop() || "document");
        const file = this.next(`pdf-${name}${name.endsWith(".pdf") ? "" : ".pdf"}`);
        fs.writeFileSync(file, body);
        log(`saved PDF response ${path.basename(file)} (${body.length} bytes)`);
      })().catch((err: unknown) => log(`PDF response not saved: ${String(err)}`));
    });
  }

  /** Screenshot + page text + tables, when the page's text changed since the last snapshot. */
  async snapshot(page: Page, reason: string): Promise<void> {
    if (page.isClosed()) return;
    const state = this.states.get(page);
    if (!state) return;
    let frames: { url: string; text: string; tables: string[][][] }[];
    try {
      frames = [];
      for (const frame of page.frames()) {
        try {
          frames.push(await frameSnapshot(frame));
        } catch {
          // A frame that navigated away mid-read; the next poll catches it.
        }
      }
    } catch {
      return;
    }
    const text = this.redact(JSON.stringify(frames));
    const hash = sha1(text);
    if (hash === state.lastTextHash) return;
    state.lastTextHash = hash;
    const base = this.next(`${reason}-${safeLabel(page.url())}`);
    fs.writeFileSync(`${base}.json`, `${JSON.stringify({ at: new Date().toISOString(), reason, frames: JSON.parse(text) }, null, 2)}\n`);
    try {
      await page.screenshot({ path: `${base}.png`, fullPage: true });
    } catch {
      // A page closing mid-shot; the text is what matters.
    }
    log(`snapshot ${path.basename(base)} (${frames.reduce((n, f) => n + f.tables.length, 0)} table(s))`);
  }

  /** Files a page built itself (data:/blob: anchors) wait on `window.__nwInlineDownloads`. */
  async drainInlineDownloads(page: Page): Promise<void> {
    if (page.isClosed()) return;
    let entries: { name: string; href: string }[];
    try {
      entries = await page.evaluate(() => {
        const w = window as unknown as { __nwInlineDownloads?: { name: string; href: string }[] };
        return (w.__nwInlineDownloads ?? []).splice(0);
      });
    } catch {
      return;
    }
    for (const entry of entries) {
      const bytes = decodeDataUrl(entry.href);
      const file = this.next(`built-${safeLabel(entry.name || "file")}`);
      fs.writeFileSync(file, bytes);
      log(`saved page-built file ${path.basename(file)} (${bytes.length} bytes)`);
    }
  }
}

/** Visible password field in any frame of the page, with its frame. */
async function findPasswordField(page: Page): Promise<Frame | null> {
  for (const frame of page.frames()) {
    try {
      if (await frame.locator('input[type="password"]:visible').count()) return frame;
    } catch {
      // detached frame
    }
  }
  return null;
}

/**
 * Best effort: open the sign-in form from the homepage and fill RUT + clave. Returns false (and the
 * user signs in by hand) when no form is found — a capture must never guess its way through a page.
 */
async function tryLogin(page: Page, rut: string, clave: string): Promise<boolean> {
  let frame = await findPasswordField(page);
  if (!frame) {
    const link = page.getByRole("link", { name: LOGIN_LINK }).or(page.getByRole("button", { name: LOGIN_LINK })).first();
    if (await link.count()) {
      log(`opening the sign-in form via «${(await link.innerText()).trim().slice(0, 40)}»`);
      await link.click();
      for (let i = 0; i < 20 && !frame; i++) {
        await page.waitForTimeout(1_000);
        for (const p of page.context().pages()) {
          frame = await findPasswordField(p);
          if (frame) {
            page = p;
            break;
          }
        }
      }
    }
  }
  if (!frame) return false;
  const password = frame.locator('input[type="password"]:visible').first();
  // The RUT field: the visible text-like input placed before the password field.
  const rutField = frame.locator('input:visible:not([type="password"]):not([type="hidden"]):not([type="checkbox"])').first();
  if (!(await rutField.count())) return false;
  await rutField.fill("");
  await rutField.fill(rut);
  await password.fill(clave);
  log("RUT and clave filled — submitting");
  await password.press("Enter");
  return true;
}

export async function runAfpUnoCapture(opts: RunOptions): Promise<number> {
  assertValidSteps(BANK, opts.only);
  if (!opts.capture) {
    throw new Error("AFP UNO has no fetcher yet — run the supervised capture: npm run fetch -- afp-uno --capture");
  }
  if (opts.background) throw new Error("the AFP UNO capture is supervised — run it without --background");
  // Config and Keychain first: a setup error is not a run and must not start the guard's clock.
  const config = loadBankConfig(BANK);
  const clave = readKeychainSecret(config.keychain_service, config.loginAccount);
  assertRunAllowed(BANK, opts.minIntervalMinutes, opts.force);
  const stamp = runStampNow();
  const recorder = new Recorder(true, stamp, BANK);
  recorder.redactSecrets([clave]);
  const dir = recorder.captureDir!;
  const session = new AfpUnoCaptureSession(dir, recorder, [clave]);

  const context: BrowserContext = await launchBrowser({ bank: BANK, headless: false });
  let closed = false;
  context.on("close", () => {
    closed = true;
  });
  try {
    for (const p of context.pages()) session.watch(p);
    context.on("page", (p) => session.watch(p));
    const page = await firstPage(context);
    session.watch(page);
    await page.goto(START_URL, { waitUntil: "domcontentloaded" });
    const filled = await tryLogin(page, config.rut, clave).catch((err: unknown) => {
      log(`sign-in form not filled (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
      return false;
    });
    log("");
    log(filled ? "Signed in automatically (check the window)." : "Could not find the sign-in form — sign in by hand in the open window.");
    log("Now, by hand, in this window:");
    log("  1. the home page with «últimos movimientos» (let it load fully)");
    log("  2. certificado «mis cotizaciones» → generate and download it");
    log("  3. certificado «movimientos» (todos los movimientos, valor en cuotas) → generate and download it");
    log(`Close the window when done (or the run ends itself after ${CAPTURE_MINUTES} min).`);
    log("");

    const deadline = Date.now() + CAPTURE_MINUTES * 60_000;
    while (!closed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      for (const p of context.pages()) {
        await session.snapshot(p, "poll");
        await session.drainInlineDownloads(p);
      }
    }
  } finally {
    if (!closed) await context.close().catch(() => undefined);
  }

  recorder.writeArtifact("run-summary.json", {
    stamp,
    bank: BANK,
    api_calls: recorder.calls.map((c) => ({ endpoint: c.endpoint, url: c.url, status: c.status })),
  });
  log(`capture → ${dir}`);
  return 0;
}
