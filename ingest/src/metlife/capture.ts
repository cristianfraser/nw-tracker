import readline from "node:readline";
import type { BrowserContext } from "playwright-core";
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
import { metlifeLoginLatch, signInWithMetlife } from "./login.js";

/**
 * MetLife Hipotecario's «Portal de Clientes» (w3.metlife.cl) — a SUPERVISED capture run. The
 * sign-in is the RUT from `cfraser/metlife-fetch.json`, the clave from its Keychain item, and the
 * «Clave Dinámica» MetLife mails (read from the mailbox, or typed with `--code-from-stdin`).
 * The run reads and parses nothing (the reader is `./read.ts`): once signed in (automatically, or
 * by hand in the open window) it records while the user clicks through — every XHR/fetch call, a
 * screenshot plus page text on each change, and every download — into
 * `cfraser/metlife-captures/<stamp>/`.
 */

const BANK = "metlife" as const;
const CAPTURE_MINUTES = 25;
const POLL_MS = 3_000;

export type MetlifeCaptureExtras = {
  /** Ask for the code on the terminal instead of reading the mailbox. */
  codeFromStdin: boolean;
  /** How long to record after the sign-in before the run ends itself (default 25 minutes). */
  captureMinutes?: number;
};

export async function codeFromTerminal(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question("MetLife Clave Dinámica (from the mail): ", (answer) => resolve(answer.trim())));
  } finally {
    rl.close();
  }
}

export async function runMetlifeCapture(opts: RunOptions, extras: MetlifeCaptureExtras = { codeFromStdin: false }): Promise<number> {
  assertValidSteps(BANK, opts.only);
  if (!opts.capture) throw new Error("runMetlifeCapture is the --capture run; the reader is fetch:metlife -- --read");
  if (opts.background) throw new Error("the MetLife capture is supervised — run it without --background");
  const config = loadBankConfig(BANK);
  metlifeLoginLatch.assertNotLatched(config.keychain_service, config.loginAccount, opts.force);
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
    try {
      await signInWithMetlife(page, {
        rut: config.rut,
        clave,
        label: "MetLife",
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
