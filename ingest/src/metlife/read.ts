/**
 * The MetLife read: sign in, open the «Centro de pago», take the three answers the page's own API
 * gives it (credits, the cuota due, the cuota history — `./statement.ts`), and send them as one
 * `mortgage.lender_statement`. The reader listens to the page's responses; it never calls the API
 * itself with the session's token. The raw answers of every live read are kept under
 * `cfraser/metlife-captures/read-<stamp>/` (personal data stays in cfraser).
 *
 * `--from-capture=<dir>` builds the same payload from a saved directory instead of logging in —
 * a supervised capture (`NNN-<endpoint>.json` files, the latest of each answer taken) or a read's
 * own `credits.json` / `pending.json` / `history.json`.
 */
import fs from "node:fs";
import path from "node:path";
import type { BrowserContext, Page, Response } from "playwright-core";
import { mortgageLenderStatementKind, type IngestResult, type MortgageLenderStatementApplyDetails } from "nw-tracker-contracts";
import { firstPage, launchBrowser } from "../browser.js";
import { runStampNow } from "../capture.js";
import { saveClaveUnicaDiagnostics } from "../claveUnica/login.js";
import { loadBankConfig } from "../config.js";
import { readKeychainSecret } from "../keychain.js";
import { log } from "../log.js";
import { clickPastOverlays, dismissOverlays } from "../overlays.js";
import { ensureDir, resolveCaptureDir } from "../paths.js";
import { assertRunAllowed } from "../runGuard.js";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { reportStepResult } from "../stepResult.js";
import { codeFromTerminal } from "./capture.js";
import { waitForMetlifeCode } from "./codeMail.js";
import { metlifeLoginLatch, signInWithMetlife } from "./login.js";
import { METLIFE_API_HOST, metlifeApiName, metlifeReadAt, metlifeStatementPayload, type MetlifeApiCall, type MetlifeApiName } from "./statement.js";

const BANK = "metlife" as const;
export const METLIFE_PAYMENT_PAGE_URL = "https://portaldeclientes.metlife.cl/PIP/centroDePago/centroDePago";
const POLL_MS = 500;
const API_NAMES: readonly MetlifeApiName[] = ["credits", "pending", "history"];

export type MetlifeReadOptions = {
  /** Build the payload from a saved directory instead of logging in. */
  fromCapture: string | null;
  /** The server applies the reading inside a transaction it rolls back, and reports. */
  dryRun: boolean;
  force: boolean;
  minIntervalMinutes: number;
  codeFromStdin: boolean;
  background: boolean;
};

/**
 * The three answers in a saved directory: every `*.json` holding a recorded call whose URL is one
 * of them; the last file (by name) of each kept. A missing answer throws.
 */
export function loadMetlifeCaptureDir(dir: string): Record<MetlifeApiName, MetlifeApiCall> {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  const found: Partial<Record<MetlifeApiName, MetlifeApiCall>> = {};
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue; // not JSON
    }
    if (raw === null || typeof raw !== "object") continue;
    const call = raw as Partial<MetlifeApiCall>;
    if (typeof call.url !== "string" || typeof call.status !== "number") continue;
    const api = metlifeApiName(call.url);
    if (!api || call.status !== 200) continue;
    found[api] = { url: call.url, status: call.status, requestBody: call.requestBody ?? null, responseBody: call.responseBody ?? null, receivedAt: String(call.receivedAt ?? "") };
  }
  const missing = API_NAMES.filter((n) => !found[n]);
  if (missing.length > 0) throw new Error(`${dir}: no ${missing.join(", ")} answer (status 200) from ${METLIFE_API_HOST}`);
  return found as Record<MetlifeApiName, MetlifeApiCall>;
}

async function recordResponse(response: Response, into: Map<MetlifeApiName, MetlifeApiCall>): Promise<void> {
  const api = metlifeApiName(response.url());
  if (!api) return;
  if (response.request().method() === "OPTIONS") return;
  let responseBody: unknown = null;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }
  let requestBody: unknown = null;
  const posted = response.request().postData();
  if (posted) {
    try {
      requestBody = JSON.parse(posted) as unknown;
    } catch {
      requestBody = posted;
    }
  }
  into.set(api, { url: response.url(), status: response.status(), requestBody, responseBody, receivedAt: new Date().toISOString() });
  log(`MetLife: ${api} answered ${response.status()}`);
}

/** Sign in, open the payment page and wait for its three answers; the raw answers are saved. */
/** How long each page gets to give the answers it asks for. */
const STEP_ANSWER_WAIT_MS = 30_000;

/** From «Mis Pagos» to the mortgage's own page, which asks for `credits` and `history`. */
const PRODUCT_PAGE_STEPS: readonly { label: string; patterns: readonly RegExp[] }[] = [
  { label: "MIS PRODUCTOS", patterns: [/^\s*mis productos\s*$/i] },
  // The product card («MUTUO HIPOTECARIO FLEXIBLE … Ver mi producto») renders after the page's own
  // answers; its link is «Ver mi producto».
  { label: "the mortgage", patterns: [/^\s*ver mi producto\s*$/i, /ver mi producto/i, /mutuo hipotecario/i] },
  { label: "the payment history", patterns: [/historial de pagos/i, /mis pagos realizados/i, /^\s*historial\s*$/i, /^\s*pagos\s*$/i] },
];

function haveAll(answers: Map<MetlifeApiName, MetlifeApiCall>, names: readonly MetlifeApiName[]): boolean {
  return names.every((n) => answers.get(n)?.status === 200);
}

/** Wait until every named answer has arrived with a 200, or the time is up; overlays are closed meanwhile. */
async function waitForAnswers(page: Page, answers: Map<MetlifeApiName, MetlifeApiCall>, names: readonly MetlifeApiName[], ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  let lastSweep = 0;
  while (!haveAll(answers, names) && Date.now() < deadline) {
    if (Date.now() - lastSweep > 5_000) {
      await dismissOverlays(page, "MetLife", "metlife-read");
      lastSweep = Date.now();
    }
    await page.waitForTimeout(POLL_MS);
  }
}

/**
 * Click the first link, button, tab or text that fits the step AND lies inside the window, through
 * any overlay; false when none. The portal keeps copies of its menu off-screen (2026-11-11: the
 * first «Mis Productos» was outside the viewport and every click on it timed out).
 */
async function clickFirstVisible(page: Page, step: { label: string; patterns: readonly RegExp[] }): Promise<boolean> {
  const deadline = Date.now() + STEP_FIND_WAIT_MS;
  for (;;) {
    if (await tryClickOnce(page, step)) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(POLL_MS);
  }
}

/** How long a step looks for its target: the page renders its cards after its own answers. */
const STEP_FIND_WAIT_MS = 20_000;

async function tryClickOnce(page: Page, step: { label: string; patterns: readonly RegExp[] }): Promise<boolean> {
  const viewport = page.viewportSize() ?? (await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })));
  for (const pattern of step.patterns) {
    for (const frame of page.frames()) {
      const candidates = [
        ...(["link", "button", "tab"] as const).map((role) => frame.getByRole(role, { name: pattern })),
        frame.getByText(pattern),
      ];
      for (const group of candidates) {
        const n = Math.min(await group.count().catch(() => 0), 20);
        for (let i = 0; i < n; i++) {
          const target = group.nth(i);
          if (!(await target.isVisible().catch(() => false))) continue;
          await target.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
          const box = await target.boundingBox().catch(() => null);
          if (!box || box.width === 0 || box.height === 0) continue;
          const inside = box.x + box.width > 0 && box.y + box.height > 0 && box.x < viewport.width && box.y < viewport.height;
          if (!inside) continue;
          log(`MetLife: opening «${(await target.innerText().catch(() => step.label)).trim().slice(0, 40)}»`);
          await clickPastOverlays(page, target, "MetLife", "metlife-read");
          return true;
        }
      }
    }
  }
  return false;
}

/** The visible links' and buttons' text, for the log when a step finds nothing. */
async function visibleControls(page: Page): Promise<string[]> {
  try {
    const all: string[] = [];
    for (const frame of page.frames()) {
      const texts = await frame
        .evaluate(() => {
          // Walk open shadow roots too: the portal's controls may sit in web components.
          const out: string[] = [];
          const walk = (root: Document | ShadowRoot) => {
            for (const el of Array.from(root.querySelectorAll("*"))) {
              if (el.shadowRoot) walk(el.shadowRoot);
              if (!el.matches("a, button, [role=tab], [role=button], [role=link]")) continue;
              const t = ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
              if (t.length > 0 && t.length < 60) out.push(t);
            }
          };
          walk(document);
          return out;
        })
        .catch(() => [] as string[]);
      all.push(...texts);
    }
    return all;
  } catch {
    return [];
  }
}

async function readLive(opts: MetlifeReadOptions, stamp: string): Promise<Record<MetlifeApiName, MetlifeApiCall>> {
  const config = loadBankConfig(BANK);
  metlifeLoginLatch.assertNotLatched(config.keychain_service, config.loginAccount, opts.force);
  const clave = readKeychainSecret(config.keychain_service, config.loginAccount);
  assertRunAllowed(BANK, opts.minIntervalMinutes, opts.force);
  const answers = new Map<MetlifeApiName, MetlifeApiCall>();
  const context: BrowserContext = await launchBrowser({ bank: BANK, headless: false, background: opts.background });
  try {
    context.on("response", (response) => {
      void recordResponse(response, answers).catch((err: unknown) => log(`MetLife: an answer could not be read (${err instanceof Error ? err.message : String(err)})`));
    });
    let page: Page = await firstPage(context);
    page = await signInWithMetlife(page, {
      rut: config.rut,
      clave,
      label: "MetLife",
      code: async (requestedAt) => {
        const code = opts.codeFromStdin ? await codeFromTerminal() : await waitForMetlifeCode({ requestedAt });
        log("MetLife: code mail received");
        return code;
      },
    });
    // The answers come from two pages (2026-11-11): «Mis Pagos» (centroDePago) asks for `pending`;
    // the mortgage's own page under «MIS PRODUCTOS» asks for `credits` and `history`. Every answer
    // of the session counts (the latest 200 per call); each step waits for what is still missing.
    await dismissOverlays(page, "MetLife", "metlife-read");
    await page.goto(METLIFE_PAYMENT_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForAnswers(page, answers, ["pending"], STEP_ANSWER_WAIT_MS);
    if (!haveAll(answers, API_NAMES)) {
      for (const step of PRODUCT_PAGE_STEPS) {
        if (haveAll(answers, API_NAMES)) break;
        const clicked = await clickFirstVisible(page, step);
        if (!clicked) {
          log(`MetLife: no «${step.label}» on the page — its links and buttons: ${(await visibleControls(page)).join(" | ").slice(0, 600)}`);
          continue;
        }
        await waitForAnswers(page, answers, API_NAMES, STEP_ANSWER_WAIT_MS);
      }
    }
    if (!haveAll(answers, API_NAMES)) {
      const state = API_NAMES.map((n) => `${n} ${answers.get(n)?.status ?? "none"}`).join(", ");
      throw new Error(`MetLife: the portal did not give all three answers (${state}); controls on the last page: ${(await visibleControls(page)).join(" | ").slice(0, 400)} (${await saveClaveUnicaDiagnostics(page, "metlife-read")})`);
    }
  } finally {
    await context.close().catch(() => undefined);
  }
  const calls = Object.fromEntries(API_NAMES.map((n) => [n, answers.get(n)!])) as Record<MetlifeApiName, MetlifeApiCall>;
  const dir = ensureDir(path.join(resolveCaptureDir(BANK), `read-${stamp}`));
  for (const n of API_NAMES) fs.writeFileSync(path.join(dir, `${n}.json`), JSON.stringify(calls[n], null, 2));
  log(`MetLife: answers saved under ${dir}`);
  return calls;
}

/** What the server did with a reading, as run-log lines; plus the counts the runner reads. */
export function describeLenderStatementResult(result: IngestResult): { lines: string[]; written: number; quoteStored: boolean } {
  const lines = [`server: ${result.status}${result.dry_run ? " (dry run)" : ""}${result.message ? ` — ${result.message}` : ""}`];
  for (const c of result.conflicts ?? []) lines.push(`  conflict ${c.at}: ${c.message}`);
  const details = (result.details ?? {}) as Partial<MortgageLenderStatementApplyDetails>;
  const quote = details.quote ?? null;
  lines.push(
    quote
      ? `  quote: cuota ${quote.cuota} due ${quote.due_on} — ${quote.stored ? "stored" : `unchanged since ${quote.first_seen_at}`}`
      : "  quote: none"
  );
  const paid = details.paid ?? [];
  for (const p of paid) lines.push(`  cuota ${p.cuota}: ${p.outcome}${p.detail ? ` — ${p.detail}` : ""}`);
  const written = paid.filter((p) => p.outcome === "written").length;
  const waiting = paid.filter((p) => p.outcome === "waiting").length;
  lines.push(`  paid cuotas: ${written} written, ${paid.filter((p) => p.outcome === "matches").length} matching, ${waiting} waiting`);
  return { lines, written, quoteStored: quote?.stored === true };
}

export async function runMetlifeRead(opts: MetlifeReadOptions): Promise<number> {
  const stamp = runStampNow();
  const calls = opts.fromCapture ? loadMetlifeCaptureDir(path.resolve(opts.fromCapture)) : await readLive(opts, stamp);
  const payload = metlifeStatementPayload(calls, metlifeReadAt(calls));
  log(
    `MetLife: credit balance ${payload.credit.balance_uf} UF; ${payload.pending.length} cuota(s) due` +
      `${payload.pending.map((p) => ` (cuota ${p.cuota} on ${p.due_on}: min ${p.min_uf} / max ${p.max_uf} UF)`).join("")}; ` +
      `${payload.history.length} history row(s), ${payload.history.filter((h) => h.status === "paid").length} paid`
  );
  const ref = `metlife-read-${opts.fromCapture ? path.basename(path.resolve(opts.fromCapture)) : stamp}`;
  let result: IngestResult;
  try {
    result = await ingestClient().send(mortgageLenderStatementKind, payload, { channel: "web_session", ref, label: `MetLife portal read ${payload.read_at}` }, { dryRun: opts.dryRun });
  } catch (err) {
    log(`MetLife: not sent — ${describeIngestFailure(err)}`);
    return 1;
  }
  const { lines, written, quoteStored } = describeLenderStatementResult(result);
  for (const line of lines) log(line);
  if (!result.dry_run) reportStepResult({ inserted: written, staged: quoteStored ? 1 : 0 });
  return result.status === "conflict" ? 1 : 0;
}
