import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Page, Response } from "playwright-core";
import { ensureDir, resolveCaptureDir } from "./paths.js";
import type { BankName } from "./config.js";
import { log } from "./log.js";

/** Santander's private-banking API host — every data call the SPA makes goes here. */
export const API_HOST_FRAGMENT = "api-dsk.santander.cl";

/**
 * Third-party traffic to ignore when recording without a host filter.
 *
 * The first Lider capture was overwhelmingly analytics beacons and Cloudflare challenge internals,
 * with the bank's own calls buried among them — and the challenge URLs carry tokens long enough to
 * break filenames. None of it is ever the data we came for.
 */
const NOISE_PATTERNS: RegExp[] = [
  /\/cdn-cgi\//i, // Cloudflare challenge platform (Turnstile)
  /google-analytics|googletagmanager|doubleclick|gstatic|google\.com/i,
  /dynatrace|ruxit|\/rum\b/i,
  /evergage|salesforce|onsiteData/i,
  /hotjar|newrelic|facebook|adobedc|cloudflareinsights|sentry/i,
  /\/collect(\?|$)/i,
];

function isThirdPartyNoise(url: string): boolean {
  return NOISE_PATTERNS.some((pattern) => pattern.test(url));
}

export type ApiCall = {
  /** Endpoint basename, e.g. "consultaUltimosMovimientos". */
  endpoint: string;
  url: string;
  status: number;
  requestBody: unknown;
  responseBody: unknown;
  /** When the response arrived (ISO) — the moment a snapshot endpoint's figures describe. */
  receivedAt: string;
};

/**
 * Records every API call the page makes, and (in capture mode) writes request/response pairs plus
 * screenshots to disk. The first supervised run is what turns the remaining unknowns — exact
 * `Importe` formatting, how many cards the swiper holds, whether a currency needs its own click —
 * into files we can read instead of guessing at.
 */
export class Recorder {
  readonly calls: ApiCall[] = [];
  private readonly dir: string | null;
  private seq = 0;
  private secrets: string[] = [];

  /**
   * @param hostFragment restrict recording to one API host (Santander's calls all go to one).
   *   Omit to record every XHR/fetch instead — the right default when the bank's API hosts are not
   *   yet known, which is exactly the situation a first capture run is meant to resolve.
   */
  constructor(
    readonly captureEnabled: boolean,
    runStamp: string,
    bank: BankName,
    private readonly hostFragment?: string,
  ) {
    this.dir = captureEnabled ? ensureDir(path.join(resolveCaptureDir(bank), runStamp)) : null;
  }

  get captureDir(): string | null {
    return this.dir;
  }

  /**
   * Strings that must never reach a capture file — a login POST carries the password in its body.
   * Replaced in everything recorded from here on, in memory and on disk.
   */
  redactSecrets(secrets: string[]): void {
    this.secrets = secrets.filter((s) => s.length > 0);
  }

  private redact<T>(value: T): T {
    if (this.secrets.length === 0 || value == null) return value;
    let text = JSON.stringify(value);
    // As JSON-escaped, and as URL-encoded (a form-encoded login body; `+` for spaces too).
    for (const s of this.secrets) {
      for (const form of [s, encodeURIComponent(s), encodeURIComponent(s).replace(/%20/g, "+")]) {
        text = text.split(JSON.stringify(form).slice(1, -1)).join("«redacted»");
      }
    }
    return JSON.parse(text) as T;
  }

  attach(page: Page): void {
    page.on("response", (response) => {
      // Recording is observation, never the job. A failure here used to surface as an unhandled
      // rejection from the event handler and kill the whole run — log it and carry on instead.
      void this.record(response).catch((err: unknown) => {
        log(`capture skipped (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
      });
    });
  }

  private async record(response: Response): Promise<void> {
    const url = response.url();
    if (this.hostFragment) {
      if (!url.includes(this.hostFragment)) return;
    } else {
      const kind = response.request().resourceType();
      if (kind !== "xhr" && kind !== "fetch") return;
      if (isThirdPartyNoise(url)) return;
    }
    const endpoint = url.split("?")[0]?.split("/").pop() ?? "unknown";
    const receivedAt = new Date().toISOString();
    let responseBody: unknown = null;
    let requestBody: unknown = null;
    try {
      responseBody = await response.json();
    } catch {
      // Non-JSON payloads (PDF bytes, redirects) are recorded by status only.
      responseBody = null;
    }
    try {
      const raw = response.request().postData();
      requestBody = raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      requestBody = response.request().postData() ?? null;
    }
    const call: ApiCall = this.redact({ endpoint, url, status: response.status(), requestBody, responseBody, receivedAt });
    this.calls.push(call);
    log(`api ${response.status()} ${safeFileLabel(endpoint)}`);
    if (!this.dir) return;
    this.seq += 1;
    const file = path.join(this.dir, `${String(this.seq).padStart(3, "0")}-${safeFileLabel(endpoint)}.json`);
    fs.writeFileSync(file, JSON.stringify(call, null, 2));
  }

  /** All recorded calls for one endpoint, oldest first. */
  callsFor(endpoint: string): ApiCall[] {
    return this.calls.filter((c) => c.endpoint === endpoint);
  }

  async screenshot(page: Page, label: string): Promise<void> {
    if (!this.dir) return;
    this.seq += 1;
    const file = path.join(this.dir, `${String(this.seq).padStart(3, "0")}-${label}.png`);
    await page.screenshot({ path: file, fullPage: true });
  }

  /** Dump a derived artifact (parsed movements, page text) next to the raw calls. */
  writeArtifact(name: string, data: unknown): void {
    if (!this.dir) return;
    fs.writeFileSync(path.join(this.dir, name), JSON.stringify(data, null, 2));
  }
}

/**
 * Turn a URL path segment into something safe to use as a filename.
 *
 * With no host filter the recorder sees every XHR, and some carry a long encoded blob as their last
 * path segment — long enough to blow past the filesystem's 255-byte name limit (`ENAMETOOLONG`,
 * hit on the first Lider run). Truncating alone would collide, so the tail is a hash of the
 * original. `call.endpoint` keeps the raw value; only the filename is rewritten.
 */
export function safeFileLabel(endpoint: string): string {
  const cleaned = endpoint.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";
  if (cleaned.length <= 60) return cleaned;
  const digest = crypto.createHash("sha1").update(endpoint).digest("hex").slice(0, 8);
  return `${cleaned.slice(0, 50)}-${digest}`;
}

export function runStampNow(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
