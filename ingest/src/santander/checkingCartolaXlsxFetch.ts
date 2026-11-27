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
 * a check stays where it was downloaded and is named in the step's problem.
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import type { Recorder } from "../capture.js";
import { downloadTo, waitForNewApiCalls } from "../wait.js";
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

export type CartolaXlsxFetchOutcome = {
  /** Months saved, with the file each became. */
  saved: { month: string; file: string }[];
  /** A month not published yet and not overdue: the step passes and stops there. */
  waiting: string | null;
  /** Why the step fails, one line each. */
  problems: string[];
};

export type CartolaXlsxFetchOptions = {
  months: readonly string[];
  account: string;
  todayIso: string;
  /** Where the bank's file is written before its checks. */
  downloadDir: string;
  /** Where a checked file goes (the inbox; in capture mode the capture's downloads). */
  destDir: string;
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
  // The innermost element holding both the month and its Excel link is the row.
  const row = page
    .locator("div, li, tr")
    .filter({ hasText: label })
    .filter({ has: page.getByText(TEXT.downloadExcel) })
    .last();
  await row.waitFor({ state: "visible", timeout: VIEW_WAIT_MS });
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

/**
 * Download `months` oldest first. Stops at the first month the bank does not list (a later one
 * cannot be listed either) and at the first failure, so the backlog is fetched in order and a
 * gap is never skipped over.
 */
export async function fetchCheckingCartolaXlsx(
  page: Page,
  recorder: Recorder,
  opts: CartolaXlsxFetchOptions,
): Promise<CartolaXlsxFetchOutcome> {
  logStep(`cuenta corriente — cartola xlsx (${opts.months.join(", ")})`);
  const outcome: CartolaXlsxFetchOutcome = { saved: [], waiting: null, problems: [] };
  await openCartolasView(page, recorder);
  for (const month of opts.months) {
    let file: string | null = null;
    try {
      const answer = await monthAnswer(page, recorder, month, opts.account);
      if (answer.kind === "not_issued") {
        const said = answer.message ? ` («${answer.message}»)` : "";
        if (unpublishedIsOverdue(month, opts.todayIso)) {
          outcome.problems.push(`cartola ${month} still not published by the bank${said}, expected by ${publicationDeadline(month)}`);
        } else {
          outcome.waiting = month;
          log(`cartola ${month} not published yet${said}; waiting until ${publicationDeadline(month)}`);
        }
        break;
      }
      file = await downloadMonth(page, month, opts.downloadDir);
      const cartola = validateDownloadedCartolaXlsx(fs.readFileSync(file), path.basename(file), { month, account: opts.account });
      const dest = moveChecked(file, opts.destDir);
      log(`cartola ${month} Nº ${answer.cartolaNumber}: ${cartola.movements.length} movements, ${cartola.period_from} → ${cartola.period_to} → ${dest}`);
      outcome.saved.push({ month, file: dest });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // A dead browser must reach the run's relaunch logic, not become a quiet problem line.
      if (browserGoneError(page, err)) throw err;
      const kept = file ? ` (the download is kept at ${file}, outside the inbox)` : "";
      // The run's step runner saves the page's diagnostics when the step fails.
      outcome.problems.push(`cartola ${month}: ${reason}${kept}`);
      break;
    }
  }
  return outcome;
}
