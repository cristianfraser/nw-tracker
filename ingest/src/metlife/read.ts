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
import { dismissOverlays } from "../overlays.js";
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
const API_WAIT_MS = 90_000;
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
    // Only answers the payment page itself receives count (the landing may have asked first).
    answers.clear();
    await dismissOverlays(page, "MetLife", "metlife-read");
    await page.goto(METLIFE_PAYMENT_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const deadline = Date.now() + API_WAIT_MS;
    let lastSweep = 0;
    while (API_NAMES.some((n) => answers.get(n)?.status !== 200)) {
      if (Date.now() >= deadline) {
        const state = API_NAMES.map((n) => `${n} ${answers.get(n)?.status ?? "none"}`).join(", ");
        throw new Error(`MetLife: the payment page did not receive its answers in ${API_WAIT_MS / 1000} s (${state}) (${await saveClaveUnicaDiagnostics(page, "metlife-read")})`);
      }
      // An overlay the page opens while it loads is closed through its own control.
      if (Date.now() - lastSweep > 5_000) {
        await dismissOverlays(page, "MetLife", "metlife-read");
        lastSweep = Date.now();
      }
      await page.waitForTimeout(POLL_MS);
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
