/**
 * Step `checking-cartola-xlsx`: the cuenta corriente's monthly cartola as the bank's «Descargar
 * Excel», the second reading of a month the mailed PDF also brings.
 *
 * Restored from the session's first version (removed 2026-08-06 before the scraper was committed;
 * its routes and texts stayed in `routes.ts`, and the captures of 2026-08-05 show what it did):
 * the movements view → «Ir a cartolas» → the CARTOLAS view asks `ultCartolaHistorica` for the
 * current month (code 16, no record) and then the previous one, and lists that cartola as
 * «Cartola emitida — Cartola Nº n · <Mes> <año> · Descargar PDF · Descargar Excel». The Excel is
 * built in the page and arrives as «Cartola de cuenta Corriente - <Mes> <año>.xlsx». An older month
 * needs the view's «Buscar por fecha», which was never captured: `searchMonth` is written blind and
 * fails with diagnostics when the form is not the one it expects (see the step's docs).
 *
 * Every file is downloaded outside the inbox, checked (`validateDownloadedCartolaXlsx`) and only
 * then moved into `cfraser/inbox/` under the bank's own name, where the inbox pipeline files it
 * (`organize:checking-cartola-xlsx`) and imports it (`import:checking-cartolas`). A file that fails
 * a check is kept outside the inbox (`refusedDir`, one copy per month) and named in the step's
 * problem; what was already reported is judged by `cartolaXlsxState.ts`.
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import type { ApiCall, Recorder } from "../capture.js";
import { normalizeAccountNumber } from "nw-tracker-contracts";
import type { ParsedCheckingCartola } from "./checkingCartolaXlsx.js";
import type { CartolaXlsxIssueKind, CartolaXlsxMonthResult } from "./cartolaXlsxState.js";
import { countApiCalls, downloadTo, waitForNewApiCalls } from "../wait.js";
import { ensureDir } from "../paths.js";
import { log, logStep } from "../log.js";
import { ROUTE, TEXT } from "./routes.js";
import { openRoute } from "./navigate.js";
import { browserGoneError } from "./stepSupport.js";
import { unpublishedIsOverdue, publicationDeadline } from "./cartolaXlsxSchedule.js";
import {
  CARTOLA_HISTORY_ENDPOINT,
  cartolaHistoryRequest,
  cartolaMonthAnswer,
  cartolaMonthLabel,
  validateDownloadedCartolaXlsx,
  type CartolaMonthAnswer,
} from "./cartolaXlsxDownload.js";

/** How long the cartolas view gets to ask for a month and show its row. */
const VIEW_WAIT_MS = 20_000;
/** How long a month the view is about to ask for gets before the step searches for it. */
const OWN_CALL_WAIT_MS = 5_000;

export type CartolaXlsxFetchOptions = {
  months: readonly string[];
  account: string;
  todayIso: string;
  /** Where the bank's file is written before its checks (emptied before each download). */
  downloadDir: string;
  /** Where a checked file goes (the inbox; in capture mode the capture's downloads). */
  destDir: string;
  /** Where a refused file is kept, one per month (null: left where it was downloaded). */
  refusedDir: string | null;
  /** Whether this exact issue of the month was reported on an earlier run: then later months go on. */
  alreadyReported: (month: string, kind: CartolaXlsxIssueKind, reason: string) => boolean;
};

function isCartolaHistoryCall(call: { endpoint: string; requestBody: unknown }): boolean {
  return cartolaHistoryRequest(call) !== null;
}

/** The movements view, then «Ir a cartolas» (or the view's CARTOLAS tab), until the view asked for a month. */
async function openCartolasView(page: Page, recorder: Recorder): Promise<void> {
  const baseline = recorder.calls.filter(isCartolaHistoryCall).length;
  await openRoute(page, ROUTE.checkingMovements);
  const go = page.getByText(TEXT.goToCartolas).or(page.getByText(TEXT.cartolasTab)).filter({ visible: true }).first();
  await go.waitFor({ state: "visible", timeout: VIEW_WAIT_MS });
  await go.click();
  if (!(await waitForNewApiCalls(recorder, isCartolaHistoryCall, baseline, VIEW_WAIT_MS))) {
    throw new Error(`cartolas view: no ${CARTOLA_HISTORY_ENDPOINT} call after opening it`);
  }
  await recorder.screenshot(page, "checking-cartolas");
}

/**
 * Ask the view for `month` through «Buscar por fecha». UNCONFIRMED: the form was never captured.
 * Assumed shape: a month and a year picker as `<select>` elements (one listing Spanish month
 * names, one listing the year) and a confirm button; anything else fails with diagnostics so a
 * `--capture` run can show the real form.
 */
async function searchMonth(page: Page, recorder: Recorder, month: string): Promise<void> {
  const baseline = recorder.calls.filter(isCartolaHistoryCall).length;
  await page.getByText(TEXT.searchByDate).filter({ visible: true }).first().click({ timeout: VIEW_WAIT_MS });
  await recorder.screenshot(page, `checking-cartolas-search-${month}`);
  const label = cartolaMonthLabel(month);
  const [monthName, year] = label.split(" ") as [string, string];
  const selects = page.locator("select").filter({ visible: true });
  let monthSet = false;
  let yearSet = false;
  for (let i = 0; i < (await selects.count()); i++) {
    const select = selects.nth(i);
    const options = (await select.locator("option").allInnerTexts()).map((t) => t.trim());
    const monthOption = options.find((o) => o.toLowerCase() === monthName.toLowerCase());
    if (!monthSet && monthOption) {
      await select.selectOption({ label: monthOption });
      monthSet = true;
    } else if (!yearSet && options.includes(year)) {
      await select.selectOption({ label: year });
      yearSet = true;
    }
  }
  if (!monthSet || !yearSet) {
    throw new Error(`«Buscar por fecha» did not show the month/year pickers this step expects (month ${monthSet}, year ${yearSet}) — run --capture --only=checking-cartola-xlsx to see the form`);
  }
  await page.getByRole("button", { name: TEXT.searchConfirm }).filter({ visible: true }).first().click({ timeout: VIEW_WAIT_MS });
  if (!(await waitForNewApiCalls(recorder, (c) => cartolaHistoryRequest(c)?.month === month, 0, VIEW_WAIT_MS))) {
    if (recorder.calls.filter(isCartolaHistoryCall).length === baseline) {
      throw new Error(`«Buscar por fecha» for ${month}: the view asked the bank nothing`);
    }
    throw new Error(`«Buscar por fecha» for ${month}: the view asked for another month`);
  }
  await recorder.screenshot(page, `checking-cartolas-${month}`);
}

/** The bank's answer for `month`, searching for it when the view has not asked for it yet. */
async function monthAnswer(page: Page, recorder: Recorder, month: string, account: string): Promise<CartolaMonthAnswer> {
  const asksFor = (c: ApiCall): boolean => {
    const req = cartolaHistoryRequest(c);
    return req !== null && req.month === month && normalizeAccountNumber(req.account) === normalizeAccountNumber(account);
  };
  // The view asks for the current month first and the previous one right after: give the call
  // for this month a moment before taking the (unconfirmed) search path.
  if (countApiCalls(recorder.calls, asksFor) === 0) await waitForNewApiCalls(recorder, asksFor, 0, OWN_CALL_WAIT_MS);
  const shown = cartolaMonthAnswer(recorder.calls, month, account);
  if (shown) return shown;
  await searchMonth(page, recorder, month);
  const searched = cartolaMonthAnswer(recorder.calls, month, account);
  if (!searched) throw new Error(`${CARTOLA_HISTORY_ENDPOINT} for ${month} was asked for another account`);
  return searched;
}

/** Click the listed row's «Descargar Excel» for `month`; the file lands in `dir` under the bank's name. */
async function downloadMonth(page: Page, month: string, dir: string): Promise<string> {
  const label = new RegExp(`\\b${cartolaMonthLabel(month).replace(" ", "\\s+")}\\b`, "i");
  // The innermost element holding both the month and its Excel link is the row. UNCONFIRMED: right
  // only while no later row prints the same month label (the 2026-08-05 view listed one row).
  const row = page
    .locator("div, li, tr")
    .filter({ hasText: label })
    .filter({ has: page.getByText(TEXT.downloadExcel) })
    .last();
  await row.waitFor({ state: "visible", timeout: VIEW_WAIT_MS });
  // One download at a time in the folder: nothing of an earlier night lingers there.
  for (const name of fs.readdirSync(ensureDir(dir))) fs.rmSync(path.join(dir, name), { force: true, recursive: true });
  return downloadTo(page, dir, async () => {
    await row.getByText(TEXT.downloadExcel).first().click();
  });
}

/** Move a checked file into `destDir` under its own name; a file already there with that name is an error. */
function moveChecked(file: string, destDir: string): string {
  const dest = path.join(ensureDir(destDir), path.basename(file));
  if (path.resolve(dest) === path.resolve(file)) return dest;
  if (fs.existsSync(dest)) throw new Error(`${path.basename(file)} is already in ${destDir}`);
  fs.renameSync(file, dest);
  return dest;
}

/** Keep a refused file as `<month> <bank name>` in `refusedDir`, replacing that month's earlier copy. */
function keepRefused(file: string, month: string, refusedDir: string | null): string {
  if (!refusedDir) return file;
  ensureDir(refusedDir);
  for (const name of fs.readdirSync(refusedDir)) {
    if (name.startsWith(`${month} `)) fs.rmSync(path.join(refusedDir, name), { force: true });
  }
  const dest = path.join(refusedDir, `${month} ${path.basename(file)}`);
  fs.renameSync(file, dest);
  return dest;
}

/**
 * Download `months` oldest first, one result per month tried. A month not published before its
 * deadline stops the run (a later one cannot be listed either), as does any failure of the step
 * itself (navigation, the download) and a month not published past its deadline or refused the
 * first time it is seen; once that exact issue was reported on an earlier run the later months
 * are tried, so a month the bank never publishes cannot block the rest forever.
 */
export async function fetchCheckingCartolaXlsx(
  page: Page,
  recorder: Recorder,
  opts: CartolaXlsxFetchOptions,
): Promise<CartolaXlsxMonthResult[]> {
  logStep(`cuenta corriente — cartola xlsx (${opts.months.join(", ")})`);
  const results: CartolaXlsxMonthResult[] = [];
  await openCartolasView(page, recorder);
  for (const month of opts.months) {
    let answer: CartolaMonthAnswer;
    let file: string;
    try {
      answer = await monthAnswer(page, recorder, month, opts.account);
      if (answer.kind === "not_issued") {
        const said = answer.message ? ` («${answer.message}»)` : "";
        if (!unpublishedIsOverdue(month, opts.todayIso)) {
          log(`cartola ${month} not published yet${said}; waiting until ${publicationDeadline(month)}`);
          results.push({ month, kind: "waiting", reason: `not published yet, expected by ${publicationDeadline(month)}` });
          break;
        }
        const reason = `still not published by the bank${said}, expected by ${publicationDeadline(month)}`;
        results.push({ month, kind: "not_published", reason, file: null });
        if (!opts.alreadyReported(month, "not_published", reason)) break;
        continue;
      }
      file = await downloadMonth(page, month, opts.downloadDir);
    } catch (err) {
      // A dead browser must reach the run's relaunch logic, not become a quiet problem line.
      if (browserGoneError(page, err)) throw err;
      results.push({ month, kind: "failed", reason: err instanceof Error ? err.message : String(err) });
      break;
    }
    let cartola: ParsedCheckingCartola;
    try {
      cartola = validateDownloadedCartolaXlsx(fs.readFileSync(file), path.basename(file), { month, account: opts.account });
    } catch (err) {
      // The reason without the download's own path, so the same refusal reads alike every night.
      const reason = (err instanceof Error ? err.message : String(err)).replace(`${path.basename(file)}: `, "");
      results.push({ month, kind: "refused", reason, file: keepRefused(file, month, opts.refusedDir) });
      if (!opts.alreadyReported(month, "refused", reason)) break;
      continue;
    }
    const dest = moveChecked(file, opts.destDir);
    const detail = `${month} Nº ${answer.cartolaNumber} → ${path.basename(dest)}`;
    log(`cartola ${detail}: ${cartola.movements.length} movements, ${cartola.period_from} → ${cartola.period_to}`);
    results.push({ month, kind: "saved", file: dest, detail });
  }
  return results;
}
