import fs from "node:fs";
import path from "node:path";
import type { Page, Response } from "playwright-core";
import type { BankConfig } from "../config.js";
import { ensureDir, resolveCaptureDir } from "../paths.js";
import { log, logStep } from "../log.js";
import { ROUTE, SELECTOR } from "./routes.js";
import { openRoute } from "./navigate.js";
import { pick, pickString } from "./payload.js";
import { browserGoneError, errorMessage, saveStepDiagnostics } from "./stepSupport.js";

/**
 * Cuenta corriente in dollars — capture only (2026-10-09).
 *
 * The dollar account has no movement feed: no xlsx download, no mail, nothing in the product
 * summary beyond its balance. The movements page's product carousel does list it, and selecting
 * its slide makes the SPA ask for its transactions — through Apigee
 * (`POST openbanking.santander.cl/…/current-accounts/transactions`) or the Tibco fallback
 * (`POST api-dsk.santander.cl/perdsk/datosCliente/consultas/mvtosYDeposiDocCtas`). The answer's
 * shape is unknown, so this step only RECORDS it, verbatim, under
 * `cfraser/santander-captures/<stamp>-usd/` for a decoder to be written from; nothing here is
 * imported, downloaded or staged. The account is told apart by the REQUEST BODY it is asked for
 * (`accountId` ending in the configured number + `currency`, or Tibco's `NumeroCuenta` +
 * `Divisa`), never by what the slide shows. Report-only: not reaching it is a message, not a
 * failure — the peso download before it and the statements after it must not depend on it.
 */

/** At most this many carousel moves: the carousel showed 5 dots on 2026-08-05. */
const MAX_SLIDE_MOVES = 6;
/** The whole step's budget, navigation and every move included. */
const STEP_BUDGET_MS = 90_000;
/** How long one slide move may take to produce its transactions call. */
const CALL_WAIT_MS = 15_000;

export const TRANSACTIONS_ENDPOINTS = {
  apigee: "/current-accounts/transactions",
  tibco: "mvtosYDeposiDocCtas",
} as const;

export type TransactionsRoute = keyof typeof TRANSACTIONS_ENDPOINTS;

/** Whether a URL is one of the two checking-transactions endpoints, and which. */
export function transactionsRouteOf(url: string): TransactionsRoute | null {
  const pathOnly = url.split("?")[0] ?? url;
  if (pathOnly.includes(TRANSACTIONS_ENDPOINTS.apigee)) return "apigee";
  if (pathOnly.includes(TRANSACTIONS_ENDPOINTS.tibco)) return "tibco";
  return null;
}

export type TransactionsRequestAccount = {
  route: TransactionsRoute;
  /** The account the request names, as written (Apigee `accountId`, Tibco `Entrada.NumeroCuenta`). */
  account: string;
  /** The currency the request names, as written, or null when the body carries none. */
  currency: string | null;
};

/** Parse a request body (JSON text, or an already-parsed object) into what it asks for. */
export function transactionsRequestAccount(url: string, body: unknown): TransactionsRequestAccount | null {
  const route = transactionsRouteOf(url);
  if (!route) return null;
  let parsed: unknown = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      return null;
    }
  }
  if (route === "apigee") {
    const account = pickString(parsed, "accountId");
    if (account === null) return null;
    return { route, account, currency: pickString(parsed, "currency") };
  }
  const entrada = pick(parsed, "Entrada", "INPUT") ?? parsed;
  const account = pickString(entrada, "NumeroCuenta");
  if (account === null) return null;
  return { route, account, currency: pickString(entrada, "Divisa", "Moneda") };
}

const bareNumber = (n: string) => n.replace(/\D/g, "").replace(/^0+/, "");

/**
 * Whether a transactions request is for the configured dollar account: the request's account
 * (digits only) ends with the configured number (leading zeros ignored — Apigee prefixes the
 * office), and the currency, when the body names one, is not the peso. The number alone is the
 * identity (a contract number names one account); the currency only guards against a peso call
 * that somehow carried the dollar contract, since the bank's own code for USD is not known yet.
 */
export function requestNamesUsdAccount(request: TransactionsRequestAccount, usdAccountNumber: string): boolean {
  const wanted = bareNumber(usdAccountNumber);
  if (wanted.length === 0) return false;
  const digits = request.account.replace(/\D/g, "");
  if (!digits.endsWith(wanted)) return false;
  if (request.currency !== null && /clp|peso|^\s*\$\s*$/i.test(request.currency)) return false;
  return true;
}

export type UsdTransactionsCall = {
  url: string;
  status: number;
  /** The request body verbatim (JSON text), or null when the request carried none. */
  requestBody: string | null;
  /** The response body verbatim. */
  responseBody: string;
  receivedAt: string;
  request: TransactionsRequestAccount;
};

export type UsdCaptureMeta = {
  fetchedAt: string;
  /** The carousel move that produced the call (0 = the slide the page opened on). */
  slideIndex: number;
  route: TransactionsRoute;
  status: number;
  /** The product name each slide shows (its first text line) — the account numbers are not kept here. */
  carouselLabels: string[];
  requestFile: string;
  responseFile: string;
  screenshotFile: string | null;
};

/**
 * Write one captured call under `<capturesDir>/<stamp>-usd/`: the request (URL + body, never
 * headers), the raw response body verbatim, and `meta.json`. Returns the directory.
 */
export function writeUsdCapture(
  capturesDir: string,
  stamp: string,
  call: UsdTransactionsCall,
  meta: Omit<UsdCaptureMeta, "requestFile" | "responseFile" | "screenshotFile" | "route" | "status">,
  screenshotFile: string | null,
): string {
  const dir = ensureDir(path.join(capturesDir, `${stamp}-usd`));
  const requestFile = "request.json";
  const responseFile = "response.json";
  fs.writeFileSync(
    path.join(dir, requestFile),
    `${JSON.stringify({ url: call.url, route: call.request.route, status: call.status, receivedAt: call.receivedAt, body: call.requestBody }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(dir, responseFile), call.responseBody);
  const full: UsdCaptureMeta = {
    ...meta,
    route: call.request.route,
    status: call.status,
    requestFile,
    responseFile,
    screenshotFile,
  };
  fs.writeFileSync(path.join(dir, "meta.json"), `${JSON.stringify(full, null, 2)}\n`);
  return dir;
}

/** The product name of each carousel slide: its first text line, so no account number is read. */
async function carouselLabels(page: Page): Promise<string[]> {
  const texts = await page
    .locator(".swiper-slide")
    .allInnerTexts()
    .catch(() => [] as string[]);
  return texts.map((t) => t.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "").filter((l) => l.length > 0);
}

/**
 * Move the carousel to its i-th slide: the pagination dot when there is one, else the next
 * arrow. Returns false when neither control exists — the carousel is not a swiper after all.
 */
async function moveCarousel(page: Page, slideIndex: number): Promise<boolean> {
  const dots = page.locator(".swiper-pagination-bullet");
  if ((await dots.count()) > slideIndex) {
    await dots.nth(slideIndex).click({ timeout: 5_000 });
    return true;
  }
  const next = page.locator(SELECTOR.swiperNext).first();
  if ((await next.count()) === 0 || !(await next.isVisible())) return false;
  const classes = (await next.getAttribute("class")) ?? "";
  if (classes.includes(SELECTOR.swiperDisabled)) return false;
  await next.click({ timeout: 5_000 });
  return true;
}

/** The step's outcome line; «USD account not reached: …» is the report-only non-outcome. */
export async function fetchCheckingUsdMovements(page: Page, config: BankConfig, stamp: string): Promise<string> {
  logStep("cuenta corriente USD — capture");
  const usdNumber = config.usd_checking_account_number;
  if (!usdNumber) {
    return "USD account not reached: santander-fetch.json declares no usd_checking_account_number";
  }
  const calls: UsdTransactionsCall[] = [];
  const onResponse = (response: Response): void => {
    const url = response.url();
    if (!transactionsRouteOf(url)) return;
    void (async () => {
      const rawRequest = response.request().postData() ?? null;
      const request = transactionsRequestAccount(url, rawRequest);
      if (!request) {
        log(`transactions call with an unreadable request body (${transactionsRouteOf(url)}) — ignored`);
        return;
      }
      const responseBody = await response.text();
      calls.push({ url, status: response.status(), requestBody: rawRequest, responseBody, receivedAt: new Date().toISOString(), request });
      log(`transactions call ${response.status()} (${request.route}, ${request.currency ?? "no currency"}) recorded`);
    })().catch((err: unknown) => log(`(transactions call not recorded: ${errorMessage(err).split("\n")[0]})`));
  };
  page.on("response", onResponse);
  const deadline = Date.now() + STEP_BUDGET_MS;
  const findUsd = (): UsdTransactionsCall | undefined => calls.find((c) => requestNamesUsdAccount(c.request, usdNumber));
  try {
    if (!page.url().includes(ROUTE.checkingMovements)) await openRoute(page, ROUTE.checkingMovements);
    let labels = await carouselLabels(page);
    let found = findUsd();
    let slideIndex = 0;
    for (let move = 1; move <= MAX_SLIDE_MOVES && !found && Date.now() < deadline; move++) {
      const before = calls.length;
      if (!(await moveCarousel(page, move))) {
        log(`carousel has no control for slide ${move} — stopping`);
        break;
      }
      slideIndex = move;
      const waitUntil = Math.min(Date.now() + CALL_WAIT_MS, deadline);
      // The call is the proof the slide loaded; a `networkidle` settle here only ever timed out.
      while (Date.now() < waitUntil && calls.length === before) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (labels.length === 0) labels = await carouselLabels(page);
      found = findUsd();
      log(`slide ${move}: ${calls.length - before} transactions call(s)` + (found ? " — the USD account" : ""));
    }
    if (!found) {
      const reason =
        calls.length === 0
          ? "no transactions call was observed on any slide"
          : `${calls.length} transactions call(s) observed, none for the configured USD account`;
      await saveStepDiagnostics(page, "checking-usd-movements", reason);
      return `USD account not reached: ${reason} (${labels.length} carousel slide(s) seen)`;
    }
    const capturesDir = resolveCaptureDir("santander");
    const dir = path.join(capturesDir, `${stamp}-usd`);
    ensureDir(dir);
    let screenshotFile: string | null = "slide.png";
    try {
      await page.screenshot({ path: path.join(dir, screenshotFile), fullPage: true, timeout: 10_000 });
    } catch (err) {
      log(`(screenshot failed: ${errorMessage(err).split("\n")[0]})`);
      screenshotFile = null;
    }
    writeUsdCapture(capturesDir, stamp, found, { fetchedAt: new Date().toISOString(), slideIndex, carouselLabels: labels }, screenshotFile);
    return `USD account captured: slide ${slideIndex}, ${found.request.route}, HTTP ${found.status}, ${found.responseBody.length} bytes → ${path.basename(dir)}/`;
  } catch (err) {
    // A dead browser is the run's business (relaunch); anything else is this step's non-outcome.
    if (browserGoneError(page, err)) throw err;
    const reason = errorMessage(err).split("\n")[0] ?? "unknown error";
    log(`✗ checking USD capture: ${reason}`);
    if (!page.isClosed()) await saveStepDiagnostics(page, "checking-usd-movements", reason);
    return `USD account not reached: ${reason}`;
  } finally {
    page.off("response", onResponse);
  }
}
