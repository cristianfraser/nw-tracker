/**
 * What the `checking-cartola-xlsx` step already reported about a month it could not bring, so a
 * month the bank never publishes, or a download refused for the same reason night after night, is
 * a step problem once and a notice afterwards — and no longer blocks the months after it.
 *
 * `cfraser/.cartola-xlsx-state.json` (written through a temp file and a rename): per month, the
 * kind (`not_published` past its deadline, `refused` download), the reason, the Chile day it was
 * first reported and the refused copy. An entry leaves when the month's xlsx is on file or the
 * month is saved; a different reason (or kind) is reported again as a problem. Only failures of
 * the month itself live here: a navigation or download error of the step is a problem every run.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveCfraserDir, writeFileAtomic } from "../paths.js";

export type CartolaXlsxIssueKind = "not_published" | "refused";

export type CartolaXlsxIssue = {
  kind: CartolaXlsxIssueKind;
  reason: string;
  reported_on: string;
  /** The refused download, kept outside the inbox (one per month). */
  file: string | null;
};

export type CartolaXlsxState = { months: Record<string, CartolaXlsxIssue> };

/** One month's outcome in a run. */
export type CartolaXlsxMonthResult =
  | { month: string; kind: "saved"; file: string; detail: string }
  /** Not published, before its deadline: the step passes and stops there. */
  | { month: string; kind: "waiting"; reason: string }
  | { month: string; kind: CartolaXlsxIssueKind; reason: string; file: string | null }
  /** The step itself failed on this month (navigation, the download): always a problem, stops the run. */
  | { month: string; kind: "failed"; reason: string };

export function cartolaXlsxStatePath(): string {
  return path.join(resolveCfraserDir(), ".cartola-xlsx-state.json");
}

export function readCartolaXlsxState(file = cartolaXlsxStatePath()): CartolaXlsxState {
  if (!fs.existsSync(file)) return { months: {} };
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CartolaXlsxState>;
  if (typeof raw !== "object" || raw === null || typeof raw.months !== "object" || raw.months === null) {
    throw new Error(`${file}: not a cartola xlsx state ({"months": {…}})`);
  }
  return { months: { ...raw.months } };
}

export function writeCartolaXlsxState(state: CartolaXlsxState, file = cartolaXlsxStatePath()): void {
  writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** Whether this exact issue of the month was already reported (so it is now a notice, and later months go on). */
export function issueAlreadyReported(
  state: CartolaXlsxState,
  month: string,
  kind: CartolaXlsxIssueKind,
  reason: string,
): boolean {
  const prior = state.months[month];
  return prior !== undefined && prior.kind === kind && prior.reason === reason;
}

/** The state without months whose xlsx is now on file. */
export function withoutMonthsOnFile(state: CartolaXlsxState, onFile: ReadonlySet<string>): CartolaXlsxState {
  return { months: Object.fromEntries(Object.entries(state.months).filter(([month]) => !onFile.has(month))) };
}

/** Months the state still waits for, oldest first (the plan keeps them in the backlog). */
export function statePendingMonths(state: CartolaXlsxState): string[] {
  return Object.keys(state.months).sort();
}

export type CartolaXlsxJudgement = {
  problems: string[];
  notices: string[];
  /** One line per month for the run summary. */
  details: string[];
  state: CartolaXlsxState;
};

/** The run's results against what was already reported: problems, notices and the next state. */
export function judgeCartolaXlsxResults(
  state: CartolaXlsxState,
  results: readonly CartolaXlsxMonthResult[],
  todayIso: string,
): CartolaXlsxJudgement {
  const months = { ...state.months };
  const problems: string[] = [];
  const notices: string[] = [];
  const details: string[] = [];
  results.forEach((r, i) => {
    const later = i < results.length - 1 ? "; later months were attempted" : "";
    switch (r.kind) {
      case "saved":
        delete months[r.month];
        details.push(r.detail);
        return;
      case "waiting":
        details.push(`${r.month} ${r.reason}`);
        return;
      case "failed":
        problems.push(`cartola ${r.month}: ${r.reason}`);
        details.push(`${r.month} failed`);
        return;
      default: {
        const kept = r.file ? ` (kept at ${r.file}, outside the inbox)` : "";
        if (issueAlreadyReported(state, r.month, r.kind, r.reason)) {
          const prior = state.months[r.month]!;
          notices.push(`cartola ${r.month}: ${r.reason}${kept} — reported on ${prior.reported_on}${later}`);
          months[r.month] = { ...prior, file: r.file ?? prior.file };
        } else {
          problems.push(`cartola ${r.month}: ${r.reason}${kept}`);
          months[r.month] = { kind: r.kind, reason: r.reason, reported_on: todayIso, file: r.file };
        }
        details.push(`${r.month} ${r.kind.replace("_", " ")}`);
      }
    }
  });
  return { problems, notices, details, state: { months } };
}
