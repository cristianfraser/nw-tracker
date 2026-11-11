import readline from "node:readline";
import type { BrowserContext, Page } from "playwright-core";
import { firstPage, launchBrowser } from "../browser.js";
import { Recorder, runStampNow } from "../capture.js";
import { SupervisedCaptureSession } from "../captureSession.js";
import { loadBankConfig } from "../config.js";
import { readKeychainSecret } from "../keychain.js";
import { log } from "../log.js";
import { assertRunAllowed } from "../runGuard.js";
import { assertValidSteps } from "../steps.js";
import type { RunOptions } from "../runTypes.js";
import { waitForMetlifeCode } from "./codeMail.js";
import { signInWithMetlife } from "./login.js";

/**
 * MetLife Hipotecario's «Portal de Clientes» (w3.metlife.cl) — a SUPERVISED capture run. The
 * sign-in is the RUT from `cfraser/metlife-fetch.json`, the clave from its Keychain item, and the
 * «Clave Dinámica» MetLife mails (read from the mailbox, or typed with `--code-from-stdin`).
 * Nothing about the private site is known yet, so the run reads and parses nothing: once signed in
 * (automatically, or by hand in the open window) it records while the user clicks through — every
 * XHR/fetch call, a screenshot plus page text on each change, and every download — into
 * `cfraser/metlife-captures/<stamp>/`. The cuota reader is built from what it shows.
 */

const BANK = "metlife" as const;
const START_URL = "https://w3.metlife.cl/";
const CAPTURE_MINUTES = 25;
const POLL_MS = 3_000;
/** A guess until the first capture: the portal offers a way out once signed in. */
const SIGNED_IN_TEXT = /cerrar sesi[oó]n|salir del portal|mis cr[eé]ditos/i;

export type MetlifeCaptureExtras = {
  /** Ask for the code on the terminal instead of reading the mailbox. */
  codeFromStdin: boolean;
  /** How long to record after the sign-in before the run ends itself (default 25 minutes). */
  captureMinutes?: number;
};

/** Signed in = on MetLife, with no password field showing and a sign-out control on the page. */
export async function metlifeIsSignedIn(page: Page): Promise<boolean> {
  if (!/^https:\/\/[^/]*metlife\.cl\//.test(page.url())) return false;
  try {
    if (await page.locator('input[type="password"]:visible').count()) return false;
    return SIGNED_IN_TEXT.test(await page.evaluate(() => document.body?.innerText ?? ""));
  } catch {
    return false;
  }
}

async function codeFromTerminal(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question("MetLife Clave Dinámica (from the mail): ", (answer) => resolve(answer.trim())));
  } finally {
    rl.close();
  }
}

export async function runMetlifeCapture(opts: RunOptions, extras: MetlifeCaptureExtras = { codeFromStdin: false }): Promise<number> {
  assertValidSteps(BANK, opts.only);
  if (!opts.capture) throw new Error("MetLife has no fetcher yet — run npm run fetch:metlife -- --capture");
  if (opts.background) throw new Error("the MetLife capture is supervised — run it without --background");
  const config = loadBankConfig(BANK);
  const clave = readKeychainSecret(config.keychain_service, config.loginAccount);
  assertRunAllowed(BANK, opts.minIntervalMinutes, opts.force);
  const stamp = runStampNow();
  const recorder = new Recorder(true, stamp, BANK);
  // The mailed code is a secret too: it is redacted from the capture as soon as it is read.
  const secrets = [clave];
  recorder.redactSecrets(secrets);
  const dir = recorder.captureDir!;
  const session = new SupervisedCaptureSession(dir, recorder, secrets);

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
    try {
      await signInWithMetlife(page, {
        rut: config.rut,
        clave,
        label: "MetLife",
        isSignedIn: metlifeIsSignedIn,
        code: async (requestedAt) => {
          const code = extras.codeFromStdin ? await codeFromTerminal() : await waitForMetlifeCode({ requestedAt });
          secrets.push(code); // the session's page text keeps this array
          recorder.redactSecrets(secrets);
          log("MetLife: code mail received");
          return code;
        },
      });
      log("");
      log("Signed in (check the window).");
    } catch (err) {
      log("");
      log(`Sign-in not completed automatically — ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      log("Finish it by hand in the open window; the capture keeps recording.");
    }
    log("Now, by hand, in this window:");
    log("  1. the home page (let it load fully)");
    log("  2. the «pagar dividendo» page with the cuota detail (min/max UF, seguros, interés, amortización)");
    log("  3. the credit's balance / estado de deuda page");
    log(`Close the window when done (or the run ends itself after ${extras.captureMinutes ?? CAPTURE_MINUTES} min).`);
    log("");

    const deadline = Date.now() + (extras.captureMinutes ?? CAPTURE_MINUTES) * 60_000;
    while (!closed && context.pages().length > 0 && Date.now() < deadline) {
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
