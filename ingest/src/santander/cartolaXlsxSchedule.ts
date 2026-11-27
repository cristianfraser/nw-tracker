/**
 * When the session downloads the cuenta corriente's monthly cartola as an xlsx (step
 * `checking-cartola-xlsx`), and which months. The same month also arrives as the mailed PDF; the
 * xlsx is its second reading, which the server cross-checks exactly.
 *
 * «On file» is what ingest can see without the server: an xlsx of the month filed under
 * `cfraser/excels/cuenta corriente/` (where the inbox pipeline's organizer moves it, kept there
 * whether its import succeeded or waits as pending) or still in `cfraser/inbox/`. Months are told
 * by the file names the organizer reads (`periodMonthFromCartolaFileName`).
 *
 * From the 1st of a month the previous month (the last closed one) is due, until its xlsx is on
 * file. Months missing between the newest xlsx on file and the last closed month are a backlog,
 * fetched oldest first, at most `MAX_MONTHS_PER_RUN` a run, so the newest file on disk only moves
 * forward through months that were really downloaded. Older gaps (before the newest file) are
 * never chased. With no xlsx on file at all, only the last closed month is due.
 *
 * A month the bank has not published yet is waited for until the `PUBLICATION_DEADLINE_DAY` of
 * the following month; past it, «not published» is a step problem.
 */
import fs from "node:fs";
import { addCalendarMonths, parseEnvFlag } from "nw-tracker-contracts";
import { isCheckingCartolaXlsxFileName, periodMonthFromCartolaFileName } from "./checkingCartolaXlsx.js";

/**
 * The step's gate, off unless set: the download was rebuilt from the August 2026 session without
 * a run against today's site, so a deploy changes nothing until a supervised
 * `fetch:santander -- --capture --only=checking-cartola-xlsx` has confirmed it and the variable
 * is set in the ingest service's plist. Read when the run starts (`--capture` and
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

/** The cartola months an xlsx in these folders covers (missing folders read as empty). */
export function cartolaXlsxMonthsOnFile(dirs: readonly string[]): Set<string> {
  const months = new Set<string>();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!isCheckingCartolaXlsxFileName(name)) continue;
      const month = periodMonthFromCartolaFileName(name);
      if (month) months.add(month);
    }
  }
  return months;
}

/** Which months tonight's session downloads, given the months on file. */
export function planCartolaXlsxDownloads(
  todayIso: string,
  onFile: ReadonlySet<string>,
  maxPerRun = MAX_MONTHS_PER_RUN,
): CartolaXlsxPlan {
  const last = lastClosedMonth(todayIso);
  if (onFile.has(last)) return { months: [], reason: `the ${last} xlsx is on file` };
  const newest = [...onFile].filter((m) => m < last).sort().at(-1);
  const months: string[] = [];
  for (let m = newest ? addCalendarMonths(newest, 1) : last; m <= last; m = addCalendarMonths(m, 1)) months.push(m);
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
