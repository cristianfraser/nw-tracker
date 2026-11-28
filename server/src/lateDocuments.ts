import { HOME_CURRENCY, isHomeCurrency } from "nw-tracker-contracts/dto/apiConstants";
import { documentLateOn } from "./documentLateDays.js";
import { insertAppMessage } from "./appMessages.js";
import { chileCalendarAddDays, chileCalendarTodayYmd, chileWallClockAt, dateAtTimeZoneWallClock } from "./chileDate.js";
import { serverConfig } from "./config.js";
import { db } from "./db.js";
import { buildImportSyncDocumentCoveragePayload, type ImportSyncDocumentCoveragePayload } from "./importSyncDocumentCoverage.js";
import { ScheduledJob } from "./schedulerKernel.js";
import type { ImportSyncDocumentAccount, ImportSyncDocumentKind } from "./importSyncDocumentTypes.js";

/**
 * An expected bank document that did not arrive (docs/document-intake-plan.md, step A). The
 * import-sync matrix knows each column's months and their state; a `missing` month becomes LATE on
 * a fixed day of the following month, and once a Chile day the server raises one notification per
 * newly late (column, month). Whatever made the document not arrive (a renamed mail, a fetch that
 * found nothing, a parser that skipped it), the hole itself is what gets reported.
 */

export { CARTOLA_LATE_DAY, CARD_STATEMENT_LATE_DAY, documentLateOn } from "./documentLateDays.js";
/** Only months that went late this recently notify: old holes in the history stay quiet. */
export const LATE_DOCUMENT_RECENT_DAYS = 60;

export const LATE_DOCUMENT_TITLE = "Document not received";
export const LATE_DOCUMENT_CHECK_FAILED_TITLE = "Document check failed";

/** The check runs at this Chile hour: after the nightly bank run and the early hourly polls. */
export const LATE_DOCUMENT_CHECK_HOUR = 9;
/** A boot after the day's slot runs the missed check this long after start (the warmers go first). */
const BOOT_CATCH_UP_DELAY_MS = 10 * 60_000;

/** A matrix column, by what it is rather than its label. */
export type LateDocumentColumnKey = {
  account_id: number;
  document_kind: ImportSyncDocumentKind;
  /** A cartola's currency (pesos), or the card's statement column (a card with one column: pesos). */
  currency: string;
};

export type LateDocument = LateDocumentColumnKey & {
  month: string;
  /** The Chile day the month's document became late. */
  late_on: string;
  /** For the notification body. */
  label: string;
};

export function lateDocumentColumnKey(acc: ImportSyncDocumentAccount): LateDocumentColumnKey {
  return {
    account_id: acc.account_id,
    document_kind: acc.document_kind,
    // A card without dollar statements has one column, its peso statements.
    currency: acc.document_kind === "cc_statement" ? (acc.cc_statement_currency ?? HOME_CURRENCY) : HOME_CURRENCY,
  };
}

/**
 * The (column, month) pairs late on `todayYmd`: state `missing`, late day reached, and that day at
 * most {@link LATE_DOCUMENT_RECENT_DAYS} back. Every other state (`not_due`, `before_first`,
 * `after_last`, a file not imported, an import without its file) is never late. Column order, then
 * newest month first.
 */
export function lateDocuments(
  payload: Pick<ImportSyncDocumentCoveragePayload, "months" | "accounts" | "cells">,
  todayYmd: string
): LateDocument[] {
  const oldestLateOn = chileCalendarAddDays(todayYmd, -LATE_DOCUMENT_RECENT_DAYS);
  const out: LateDocument[] = [];
  payload.accounts.forEach((acc, col) => {
    payload.months.forEach((month, row) => {
      const cell = payload.cells[row]?.[col];
      if (!cell) throw new Error(`late documents: no cell for month ${month}, column ${col}`);
      if (cell.state !== "missing") return;
      const lateOn = documentLateOn(acc.document_kind, month);
      if (lateOn > todayYmd || lateOn < oldestLateOn) return;
      out.push({ ...lateDocumentColumnKey(acc), month, late_on: lateOn, label: acc.label });
    });
  });
  return out;
}

export function lateDocumentMessage(d: LateDocument): string {
  const column = d.document_kind === "cc_statement" && !isHomeCurrency(d.currency) ? `${d.label} ${d.currency.toUpperCase()}` : d.label;
  const noun = d.document_kind === "cc_statement" ? "statement" : "cartola";
  return `${column}: the ${d.month} ${noun} has not arrived (expected by ${d.late_on}).`;
}

/**
 * Raises one notification per late pair not notified before, with its row in
 * `late_document_notifications` (both in one transaction). Returns the pairs notified now.
 */
export function notifyLateDocuments(late: readonly LateDocument[]): LateDocument[] {
  const remember = db.prepare(
    `INSERT OR IGNORE INTO late_document_notifications (account_id, document_kind, currency, month) VALUES (?, ?, ?, ?)`
  );
  return db.transaction(() => {
    const notified: LateDocument[] = [];
    for (const d of late) {
      if (remember.run(d.account_id, d.document_kind, d.currency, d.month).changes === 0) continue;
      insertAppMessage("notification", LATE_DOCUMENT_TITLE, lateDocumentMessage(d));
      notified.push(d);
    }
    return notified;
  })();
}

/** Whether a notification with `title` was written on the Chile day `todayYmd`. */
function notifiedOnChileDay(title: string, todayYmd: string): boolean {
  const row = db
    .prepare(`SELECT created_at FROM app_messages WHERE kind = 'notification' AND title = ? ORDER BY id DESC LIMIT 1`)
    .get(title) as { created_at: string } | undefined;
  return row != null && chileWallClockAt(new Date(`${row.created_at.replace(" ", "T")}Z`)).ymd === todayYmd;
}

/**
 * Today's check. The coverage builder throws on integrity problems (a statement without its period,
 * a PDF that does not resolve), and writing the notifications can fail too: either raises one
 * «Document check failed» notification per Chile day (a restart's catch-up run does not repeat it)
 * and the check runs again at tomorrow's slot.
 */
export function runLateDocumentCheck(todayYmd = chileCalendarTodayYmd()): "ok" | "failed" {
  try {
    const notified = notifyLateDocuments(lateDocuments(buildImportSyncDocumentCoveragePayload(), todayYmd));
    if (notified.length > 0) console.log(`late-documents: ${notified.length} document(s) newly late`);
    return "ok";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`late-documents: the check failed — ${msg}`);
    if (!notifiedOnChileDay(LATE_DOCUMENT_CHECK_FAILED_TITLE, todayYmd)) {
      insertAppMessage(
        "notification",
        LATE_DOCUMENT_CHECK_FAILED_TITLE,
        `The check for documents that did not arrive failed, so none was looked for: ${msg}\n` +
          `The check runs again tomorrow at ${String(LATE_DOCUMENT_CHECK_HOUR).padStart(2, "0")}:00.`
      );
    }
    return "failed";
  }
}

/**
 * When the check next runs: today's slot while it is ahead; past it, at once (not before
 * `earliestMs`) when today's check has not run; else tomorrow's slot.
 */
export function nextLateDocumentCheckAtMs(input: {
  nowMs: number;
  todayYmd: string;
  lastRunYmd: string | null;
  earliestMs: number;
}): number {
  const slot = (ymd: string) => dateAtTimeZoneWallClock(ymd, LATE_DOCUMENT_CHECK_HOUR, 0, "America/Santiago").getTime();
  const todaySlot = slot(input.todayYmd);
  if (input.nowMs < todaySlot) return todaySlot;
  if (input.lastRunYmd !== input.todayYmd) return Math.max(input.nowMs, input.earliestMs);
  return slot(chileCalendarAddDays(input.todayYmd, 1));
}

/** The Chile day of the last check (in memory: a restart's catch-up re-runs it, the table keeps it quiet). */
let lastRunYmd: string | null = null;
let startedAtMs = 0;

const lateDocumentJob = new ScheduledJob({
  name: "late-documents",
  enabled: () => serverConfig().lateDocumentCheck,
  next: (nowMs) =>
    nextLateDocumentCheckAtMs({
      nowMs,
      todayYmd: chileCalendarTodayYmd(),
      lastRunYmd,
      earliestMs: startedAtMs + BOOT_CATCH_UP_DELAY_MS,
    }),
  run: async () => {
    const today = chileCalendarTodayYmd();
    // Set first: a failed check waits for tomorrow's slot, it does not loop.
    lastRunYmd = today;
    return runLateDocumentCheck(today);
  },
});

export function startLateDocumentCheck(): void {
  if (lateDocumentJob.isEnabled) return;
  if (!serverConfig().lateDocumentCheck) {
    console.log("late-documents: disabled (LATE_DOCUMENT_CHECK_ENABLED=0, background jobs off, or the demo)");
    return;
  }
  startedAtMs = Date.now();
  lateDocumentJob.start();
}
