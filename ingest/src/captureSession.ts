import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import type { Recorder } from "./capture.js";
import { log } from "./log.js";
import { decodeDataUrl } from "./wait.js";

/**
 * What a supervised capture run records while the user clicks through a site by hand (first used
 * for AFP UNO, shared with the AFC): every XHR/fetch call through the Recorder (secrets redacted
 * from anything written), a screenshot plus the page's text and every table's cells whenever a
 * page loads or its text changes (an SPA renders without a navigation), and every file the site
 * hands over — a real download, a file the page builds itself (data:/blob: anchors, kept by
 * browser.ts's init script), or a PDF opened in a tab.
 */

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

export class SupervisedCaptureSession {
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
