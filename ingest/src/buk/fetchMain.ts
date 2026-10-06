/**
 * Download the payslips (liquidaciones de sueldo) the employer publishes on its Buk portal:
 *
 *   npm run fetch:buk-payslips -w nw-tracker-ingest              # downloads what is missing
 *   npm run fetch:buk-payslips -w nw-tracker-ingest -- --dry-run # lists, downloads nothing
 *
 * Buk signs in at `<company>.buk.cl/users/sign_in` in two steps (e-mail, then password) — the
 * e-mail is the WORK address, not the personal one (`cfraser/buk-fetch.json`, Keychain
 * `nw-tracker-buk`). The portal's «Últimas liquidaciones» shortcut leads to the employee's
 * liquidaciones table, one row per month («09-2026») with a print link to
 * `/cl/liquidacions/<id>.pdf`. Each month not already on disk is saved as
 * `cfraser/liquidaciones/<YYYY>/<YYYY-MM>.pdf` — the payslip parser reads the period from that
 * name — and the run ends there: `parse:payroll-liquidaciones` + `import:payroll-liquidaciones`
 * take it from the folder, as for every other employer.
 *
 * Exit status: non-zero when the sign-in or the table read fails, or a download is not a PDF.
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { firstPage, launchBrowser } from "../browser.js";
import { loadBankConfig } from "../config.js";
import { readKeychainSecret } from "../keychain.js";
import { log } from "../log.js";
import { ensureDir, resolveCfraserDir } from "../paths.js";
import { assertRunAllowed, DEFAULT_MIN_INTERVAL_MINUTES } from "../runGuard.js";
import { periodFromBukMonth, type PayslipRow } from "./payslipTable.js";

const BANK = "buk" as const;
const BASE_URL = "https://webdoxclm.buk.cl";

const dryRun = process.argv.includes("--dry-run");
const background = process.argv.includes("--background");
const force = process.argv.includes("--force");

function liquidacionesDir(): string {
  return path.join(resolveCfraserDir(), "liquidaciones");
}

/** A screenshot and the page's text, for an unattended failure; returns where they went. */
async function saveDiagnostics(page: Page, label: string): Promise<string> {
  const base = path.join(ensureDir(path.join(resolveCfraserDir(), "scraper-diagnostics")), `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  try {
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    fs.writeFileSync(`${base}.txt`, `${page.url()}\n\n${await page.evaluate(() => document.body?.innerText ?? "")}`);
    return `see ${path.relative(resolveCfraserDir(), base)}.png`;
  } catch (err) {
    return `no screenshot: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Two-step sign-in; ends on the portal. Throws with Buk's own words when it refuses. */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  if (!page.url().includes("/users/sign_in")) return; // still signed in
  // Enter submits each step: the e-mail step's button is a <button>, the password step's an <input>.
  const emailField = page.locator('input[type="email"]');
  await emailField.fill(email);
  await emailField.press("Enter");
  const passwordField = page.locator('input[type="password"]:visible');
  await passwordField.waitFor({ timeout: 30_000 });
  await passwordField.fill(password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/users/"), { timeout: 45_000 }).catch(() => undefined),
    passwordField.press("Enter"),
  ]);
  if (page.url().includes("/users/")) {
    const why = (await page.evaluate(() => document.body?.innerText ?? "")).split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join(" — ");
    throw new Error(`Buk: sign-in refused («${why}», ${await saveDiagnostics(page, "buk-login")})`);
  }
}

/** The employee's liquidaciones table, newest first as Buk lists it. */
async function readPayslipTable(page: Page): Promise<PayslipRow[]> {
  // The portal's shortcut names the employee id; reading it keeps the id out of the config.
  await page.goto(`${BASE_URL}/static_pages/portal`, { waitUntil: "domcontentloaded" });
  const shortcut = page.locator('a[href*="/liquidaciones"]').first();
  await shortcut.waitFor({ state: "attached", timeout: 30_000 });
  const href = await shortcut.getAttribute("href");
  if (!href || !/\/profile\/employees\/\d+\/liquidaciones/.test(href)) {
    throw new Error(`Buk: liquidaciones shortcut not found on the portal (${await saveDiagnostics(page, "buk-portal")})`);
  }
  // Without the shortcut's `?source_request=Shortcuts`: that variant lists only the last three
  // months, labelled «Septiembre 2026»; the plain path is the full table with «09-2026».
  await page.goto(`${BASE_URL}${new URL(href, BASE_URL).pathname}`, { waitUntil: "domcontentloaded" });
  await page.locator("table").first().waitFor({ timeout: 30_000 });
  const raw = await page.evaluate(() =>
    Array.from(document.querySelectorAll("table tr"))
      .map((tr) => {
        const month = Array.from(tr.querySelectorAll("td")).map((td) => (td as HTMLElement).innerText.trim()).find((t) => /^\d{2}-\d{4}$/.test(t));
        const pdf = Array.from(tr.querySelectorAll('a[href$=".pdf"]')).map((a) => (a as HTMLAnchorElement).href);
        return month ? { month, pdf } : null;
      })
      .filter((r): r is { month: string; pdf: string[] } => r !== null)
  );
  if (raw.length === 0) {
    fs.writeFileSync(path.join(ensureDir(path.join(resolveCfraserDir(), "scraper-diagnostics")), "buk-table.html"), await page.content());
    throw new Error(`Buk: no month rows in the liquidaciones table (${await saveDiagnostics(page, "buk-table")})`);
  }
  return raw.map((r) => {
    if (r.pdf.length !== 1) throw new Error(`Buk: row ${r.month} has ${r.pdf.length} PDF links`);
    return { period: periodFromBukMonth(r.month), pdfUrl: r.pdf[0]! };
  });
}

async function main(): Promise<number> {
  const config = loadBankConfig(BANK);
  const password = readKeychainSecret(config.keychain_service, config.loginAccount);
  assertRunAllowed(BANK, DEFAULT_MIN_INTERVAL_MINUTES, force);

  const context = await launchBrowser({ bank: BANK, headless: false, background });
  let saved = 0;
  try {
    const page = await firstPage(context);
    await signIn(page, config.loginAccount, password);
    const rows = await readPayslipTable(page);
    log(`Buk: ${rows.length} liquidación(es) listed: ${rows.map((r) => r.period).join(", ")}`);
    for (const row of rows) {
      const file = path.join(liquidacionesDir(), row.period.slice(0, 4), `${row.period}.pdf`);
      if (fs.existsSync(file)) continue;
      if (dryRun) {
        console.log(`  would save ${row.period} → ${path.relative(resolveCfraserDir(), file)}`);
        continue;
      }
      const res = await context.request.get(row.pdfUrl, { timeout: 90_000 });
      if (!res.ok()) throw new Error(`Buk: ${row.period} PDF answered HTTP ${res.status()}`);
      const body = await res.body();
      if (body.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error(`Buk: ${row.period} download is not a PDF`);
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, body);
      // The same liquidación as Buk renders it in the browser: kept beside the PDF as a second
      // reading of the figures (the parser reads the PDF; the folder scan takes *.pdf only).
      const html = await context.request.get(row.pdfUrl.replace(/\.pdf$/, ""), { timeout: 90_000 });
      if (!html.ok()) throw new Error(`Buk: ${row.period} web view answered HTTP ${html.status()}`);
      fs.writeFileSync(file.replace(/\.pdf$/, ".html"), await html.body());
      saved += 1;
      console.log(`  saved ${row.period} → ${path.relative(resolveCfraserDir(), file)} (${body.length} bytes)`);
    }
  } finally {
    await context.close();
  }
  console.log(saved > 0 ? `Buk: ${saved} new liquidación(es)` : "Buk: nothing new");
  return 0;
}

process.exitCode = await main().catch((err: unknown) => {
  log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  return 1;
});
