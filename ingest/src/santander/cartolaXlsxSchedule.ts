/**
 * When the session downloads the cuenta corriente's monthly cartola as an xlsx (step
 * `checking-cartola-xlsx`), and which months. The same month also arrives as the mailed PDF; the
 * xlsx is its second reading, which the server cross-checks exactly.
 *
 * «On file» is what ingest can see without the server: an xlsx of the month filed under
 * `cfraser/excels/cuenta corriente/` by the organizer (its own names; kept there whether its import
 * succeeded or waits as pending), or a workbook in `cfraser/inbox/` whose header is that month's
 * cartola of the configured cuenta corriente (an inbox name is not trusted).
 *
 * From the 1st of a month the previous month (the last closed one) is due, until its xlsx is on
 * file. Months missing between the newest xlsx on file and the last closed month are a backlog,
 * fetched oldest first, at most `MAX_MONTHS_PER_RUN` a run; a month an earlier run reported as not
 * published or refused (`cartolaXlsxState.ts`) stays in the backlog until its file is on file.
 * Older gaps (before the newest file) are never chased. With no xlsx on file at all, only the last
 * closed month is due.
 *
 * A month the bank has not published yet is waited for until the `PUBLICATION_DEADLINE_DAY` of
 * the following month; past it, «not published» is a step problem.
 */
import fs from "node:fs";
import path from "node:path";
import { addCalendarMonths, parseEnvFlag } from "nw-tracker-contracts";
import { canonicalCheckingCartolaXlsxFileName, periodMonthFromCartolaFileName } from "./checkingCartolaXlsx.js";
import { cartolaXlsxHeaderMonth } from "./cartolaXlsxDownload.js";

/**
 * The step's gate, off unless set: the download was rebuilt from the August 2026 session without
 * a run against today's site, so a deploy changes nothing until a supervised
 * `fetch:santander -- --capture --only=checking-cartola-xlsx` has confirmed it and the variable
 * is set in the ingest service's plist. Read once when the session's run starts (`--capture` and
 * `--only=checking-cartola-xlsx` run the step regardless).
 */
export const CARTOLA_XLSX_FETCH_ENV = "NW_TRACKER_CARTOLA_XLSX_FETCH";

/** The run summary's line for a session that leaves the step off. */
export const CARTOLA_XLSX_GATE_SKIP = `${CARTOLA_XLSX_FETCH_ENV} is not set`;

export function cartolaXlsxFetchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseEnvFlag(CARTOLA_XLSX_FETCH_ENV, env[CARTOLA_XLSX_FETCH_ENV]) ?? false;
}

/** Months one run downloads at most (a backlog spreads over nights). */
export const MAX_MONTHS_PER_RUN = 3;

/** Day of the following month from which a month the bank does not list is a failure. */
export const PUBLICATION_DEADLINE_DAY = 10;

export type CartolaXlsxPlan = {
  /** Months to download tonight, oldest first; empty when nothing is due. */
  months: string[];
  /** Why: printed as the step's detail when nothing is due. */
  reason: string;
};

/** The month before the Chile day's month: the newest cartola that can exist. */
export function lastClosedMonth(todayIso: string): string {
  return addCalendarMonths(todayIso.slice(0, 7), -1);
}

/**
 * The months filed under the organizer's folder (`cfraser/excels/cuenta corriente/`): only the
 * organizer's own names count there (`canonicalCheckingCartolaXlsxFileName` of the name is the name).
 */
export function filedCartolaXlsxMonths(dir: string): Set<string> {
  const months = new Set<string>();
  if (!fs.existsSync(dir)) return months;
  for (const name of fs.readdirSync(dir)) {
    if (canonicalCheckingCartolaXlsxFileName(name) !== name) continue;
    const month = periodMonthFromCartolaFileName(name);
    if (month) months.add(month);
  }
  return months;
}

/**
 * The months a workbook waiting in the inbox covers. Its name is not trusted: a workbook counts
 * only when its header is the configured peso cuenta corriente's cartola (`cartolaXlsxHeaderMonth`)
 * and its name names the same month (the organizer files it by the name).
 */
export function inboxCartolaXlsxMonths(dir: string, account: string): Set<string> {
  const months = new Set<string>();
  if (!fs.existsSync(dir)) return months;
  for (const name of fs.readdirSync(dir)) {
    if (!name.toLowerCase().endsWith(".xlsx")) continue;
    let month: string | null;
    try {
      month = cartolaXlsxHeaderMonth(fs.readFileSync(path.join(dir, name)), account);
    } catch (err) {
      throw new Error(`inbox workbook ${name} cannot be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (month && periodMonthFromCartolaFileName(name) === month) months.add(month);
  }
  return months;
}

/**
 * Which months tonight's session downloads, oldest first, at most `maxPerRun`: the months after the
 * newest one on file through the last closed month, plus the months an earlier run reported and
 * still waits for (`pending`, from the step's state), so a month the bank never published is
 * never forgotten once later ones are on file.
 */
export function planCartolaXlsxDownloads(
  todayIso: string,
  onFile: ReadonlySet<string>,
  pending: readonly string[] = [],
  maxPerRun = MAX_MONTHS_PER_RUN,
): CartolaXlsxPlan {
  const last = lastClosedMonth(todayIso);
  const newest = [...onFile].filter((m) => m <= last).sort().at(-1);
  const wanted = new Set(pending.filter((m) => m <= last && !onFile.has(m)));
  for (let m = newest ? addCalendarMonths(newest, 1) : last; m <= last; m = addCalendarMonths(m, 1)) wanted.add(m);
  const months = [...wanted].sort();
  if (months.length === 0) return { months: [], reason: `the ${last} xlsx is on file` };
  const tonight = months.slice(0, maxPerRun);
  const backlog = months.length > tonight.length ? ` (${months.length - tonight.length} more on later runs)` : "";
  return { months: tonight, reason: `${months.join(", ")} not on file${backlog}` };
}

/** The day from which a month the bank still does not list is a failure: the deadline day of the next month. */
export function publicationDeadline(month: string): string {
  return `${addCalendarMonths(month, 1)}-${String(PUBLICATION_DEADLINE_DAY).padStart(2, "0")}`;
}

/** Whether a month the bank does not list yet is a failure today (else it is waited for). */
export function unpublishedIsOverdue(month: string, todayIso: string): boolean {
  return todayIso >= publicationDeadline(month);
}
