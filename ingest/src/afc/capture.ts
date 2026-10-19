import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { BrowserContext, Page } from "playwright-core";
import { firstPage, launchBrowser } from "../browser.js";
import { Recorder, runStampNow } from "../capture.js";
import { SupervisedCaptureSession } from "../captureSession.js";
import { CLAVE_UNICA_KEYCHAIN_SERVICE, signInWithClaveUnica } from "../claveUnica/login.js";
import { signInWithAfcClave } from "./login.js";
import { waitForClaveUnicaCode } from "../claveUnica/codeMail.js";
import { loadBankConfig } from "../config.js";
import { readKeychainSecret } from "../keychain.js";
import { log } from "../log.js";
import { assertRunAllowed } from "../runGuard.js";
import { assertValidSteps } from "../steps.js";
import type { RunOptions } from "../runTypes.js";

/**
 * AFC's sucursal virtual (personas.afc.cl) — a SUPERVISED capture run. The sign-in is the AFC's
 * own clave (RUT from `cfraser/afc-fetch.json`, clave from its Keychain item; `--clave-unica`
 * signs in through ClaveÚnica with its e-mail code instead); nothing about the private site
 * is known yet, so the run reads and parses nothing: once signed in it records while the user
 * clicks through by hand — every XHR/fetch call, a screenshot plus page text on each change, and
 * every PDF or download the site hands over — into `cfraser/afc-captures/<stamp>/`. The nightly
 * read is built from what it shows.
 */

const BANK = "afc" as const;
const START_URL = "https://personas.afc.cl/auth/login";
const CAPTURE_MINUTES = 25;
const POLL_MS = 3_000;
/**
 * Sidebar entries (exact text) the capture opens by itself after the sign-in, each with the
 * in-page controls (visible text) it then clicks in order — tabs, document cards, the buttons a
 * card opens (2026-10-17: the pages load nothing until one is clicked).
 */
const TOUR: readonly { item: string; clicks: readonly string[] }[] = [
  // `select:<label>` picks that option on the page's first visible <select> (the period choosers,
  // 2026-10-17: «Seleccione período» → Últimos 12/24/36 Meses / Histórico; «Seleccione el año»).
  { item: "Mis cotizaciones", clicks: ["Cotizaciones pagadas", "select:Histórico", "Descargar"] },
  { item: "Cartolas", clicks: ["Cuenta individual de cesantía", "select:2026", "Descargar", "Movimientos", "select:2026", "Descargar"] },
  { item: "Certificados", clicks: ["Cotizaciones pagadas", "select:Últimos 12 Meses", "Descargar"] },
];
const TOUR_SETTLE_MS = 8_000;
const TOUR_CLICK_TIMEOUT_MS = 6_000;

export type AfcCaptureExtras = {
  /** Sign in through ClaveÚnica (with its e-mail code) instead of the AFC's own clave. */
  claveUnica: boolean;
  /** Ask for the code on the terminal instead of reading the mailbox (a first run without IMAP). */
  codeFromStdin: boolean;
  /** How long to record after the sign-in before the run ends itself (default 25 minutes). */
  captureMinutes?: number;
};

/** Signed in = on the sucursal virtual, off its /auth pages. */
export async function afcIsSignedIn(page: Page): Promise<boolean> {
  const url = page.url();
  return /^https:\/\/personas\.afc\.cl\//.test(url) && !/\/auth(\/|$|\?)/.test(url);
}

/** Every anchor and router link on the page: text and absolute href. */
async function pageLinks(page: Page): Promise<{ text: string; href: string }[]> {
  try {
    return await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href], [routerlink], [ng-reflect-router-link]")).map((el) => {
        const a = el as HTMLAnchorElement;
        const route = el.getAttribute("routerlink") ?? el.getAttribute("ng-reflect-router-link") ?? "";
        const href = a.href || (route ? new URL(route, location.origin).href : "");
        return { text: (a.innerText ?? a.textContent ?? "").replace(/\s+/g, " ").trim(), href };
      })
    );
  } catch {
    return [];
  }
}

async function codeFromTerminal(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question("ClaveÚnica code (from the mail): ", (answer) => resolve(answer.trim())));
  } finally {
    rl.close();
  }
}

export async function runAfcCapture(opts: RunOptions, extras: AfcCaptureExtras = { claveUnica: false, codeFromStdin: false }): Promise<number> {
  assertValidSteps(BANK, opts.only);
  if (!opts.capture) throw new Error("AFC has no fetcher yet — run the supervised capture: npm run fetch:afc -- --capture");
  if (opts.background) throw new Error("the AFC capture is supervised — run it without --background");
  const config = loadBankConfig(BANK);
  const clave = readKeychainSecret(extras.claveUnica ? CLAVE_UNICA_KEYCHAIN_SERVICE : config.keychain_service, config.loginAccount);
  assertRunAllowed(BANK, opts.minIntervalMinutes, opts.force);
  const stamp = runStampNow();
  const recorder = new Recorder(true, stamp, BANK);
  recorder.redactSecrets([clave]);
  const dir = recorder.captureDir!;
  const session = new SupervisedCaptureSession(dir, recorder, [clave]);

  const context: BrowserContext = await launchBrowser({ bank: BANK, headless: false });
  let closed = false;
  context.on("close", () => {
    closed = true;
  });
  try {
    for (const p of context.pages()) session.watch(p);
    context.on("page", (p) => session.watch(p));
    let page = await firstPage(context);
    session.watch(page);
    await page.goto(START_URL, { waitUntil: "domcontentloaded" });
    try {
      page = extras.claveUnica
        ? await signInWithClaveUnica(page, {
            run: config.rut,
            clave,
            label: "AFC",
            isSignedIn: afcIsSignedIn,
            code: extras.codeFromStdin ? codeFromTerminal : (requestedAt) => waitForClaveUnicaCode({ requestedAt }),
          })
        : await signInWithAfcClave(page, { rut: config.rut, clave, label: "AFC", isSignedIn: afcIsSignedIn });
      log("");
      log("Signed in (check the window).");
    } catch (err) {
      log("");
      log(`Sign-in not completed automatically — ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      log("Finish it by hand in the open window; the capture keeps recording.");
    }
    // A scripted tour of the pages the nightly read will need, so an unattended capture records
    // their API calls too. The sidebar is collapsed by default (its entries are in the DOM but not
    // clickable, 2026-10-17), so the tour reads every link's href and navigates by URL; the links
    // are kept in the capture for the reader to be built on.
    const links = await pageLinks(page);
    fs.writeFileSync(path.join(dir, "links.json"), `${JSON.stringify(links, null, 2)}\n`);
    log(`tour: ${links.length} link(s) on the home page`);
    for (const { item, clicks } of TOUR) {
      const link = links.find((l) => l.text === item) ?? links.find((l) => l.text.toLowerCase().includes(item.toLowerCase()));
      if (!link?.href) {
        log(`tour: no link for «${item}»`);
        continue;
      }
      const slug = item.toLowerCase().replace(/\s+/g, "-");
      log(`tour: opening «${item}» → ${link.href}`);
      await page.goto(link.href, { waitUntil: "domcontentloaded" }).catch((err: unknown) => log(`tour: navigation failed — ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`));
      await page.waitForTimeout(TOUR_SETTLE_MS);
      await session.snapshot(page, `tour-${slug}`);
      fs.writeFileSync(path.join(dir, `links-${slug}.json`), `${JSON.stringify(await pageLinks(page), null, 2)}\n`);
      for (const text of clicks) {
        if (text.startsWith("select:")) {
          const label = text.slice("select:".length);
          const select = page.locator("select").locator("visible=true").first();
          if (await select.count().catch(() => 0)) {
            log(`tour:   selecting «${label}»`);
            await select.selectOption({ label }, { timeout: TOUR_CLICK_TIMEOUT_MS }).catch((err: unknown) => log(`tour:   select failed — ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`));
          } else {
            // A custom chooser: open it by its placeholder, then click the option by its text.
            const opener = page.locator("body").getByText(/^Seleccione/, { exact: false }).locator("visible=true").first();
            if (await opener.count().catch(() => 0)) {
              log(`tour:   opening the chooser «${(await opener.innerText().catch(() => "")).trim().slice(0, 30)}»`);
              await opener.click({ timeout: TOUR_CLICK_TIMEOUT_MS }).catch((err: unknown) => log(`tour:   chooser click failed — ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`));
              await page.waitForTimeout(1_500);
            }
            const option = page.locator("body").getByText(label, { exact: true }).locator("visible=true").last();
            if (!(await option.count().catch(() => 0))) {
              log(`tour:   option «${label}» not visible`);
              await session.snapshot(page, `tour-${slug}-chooser`);
              continue;
            }
            log(`tour:   choosing «${label}»`);
            await option.click({ timeout: TOUR_CLICK_TIMEOUT_MS }).catch((err: unknown) => log(`tour:   option click failed — ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`));
          }
          await page.waitForTimeout(2_000);
          continue;
        }
        // Visible content only (the collapsed sidebar repeats some of these words).
        const target = page.locator("main, [role=main], .content, body").last().getByText(text, { exact: true }).locator("visible=true").first();
        if (!(await target.count().catch(() => 0))) {
          log(`tour:   «${text}» not on the page`);
          continue;
        }
        log(`tour:   clicking «${text}»`);
        await target.click({ timeout: TOUR_CLICK_TIMEOUT_MS }).catch((err: unknown) => log(`tour:   click failed — ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`));
        await page.waitForTimeout(TOUR_SETTLE_MS);
        await session.snapshot(page, `tour-${slug}-${text.toLowerCase().replace(/\s+/g, "-")}`);
        await session.drainInlineDownloads(page);
      }
    }
    log("Now, by hand, in this window:");
    log("  1. the home page with the saldo (let it load fully)");
    log("  2. the movements / cartola view, as far back as it goes");
    log("  3. certificado de cotizaciones → generate and download it");
    log("  4. the cartola cuatrimestral (estado de cuenta) → generate and download one");
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
