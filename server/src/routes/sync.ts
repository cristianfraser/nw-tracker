/** Global sync status/force, import-sync admin, messages. Split verbatim from index.ts; paths unchanged. */
import express from "express";
import {
  listAppMessages,
  markAllNotificationsRead,
  unreadNotificationCount,
} from "../appMessages.js";
import {
  forceSyncSourceStale,
  isGlobalSyncSource,
  syncStatusPayload,
} from "../globalSyncStale.js";
import { buildImportSyncDocumentCoveragePayload } from "../importSyncDocumentCoverage.js";
import {
  IMPORT_SYNC_DOCUMENT_SLOTS,
  importSyncDocumentContentDisposition,
  importSyncDocumentContentType,
  documentSendFailure,
  readImportSyncSheetPreview,
  resolveImportSyncDocumentColumn,
  resolveImportSyncDocumentFile,
  type ImportSyncDocumentFile,
} from "../importSyncDocumentFile.js";
import {
  createExpenseGenericUniqueMerchant,
  deleteExpenseGenericUniqueMerchant,
  listExpenseGenericUniqueMerchants,
  updateExpenseGenericUniqueMerchant,
} from "../expenseGenericUniqueMerchants.js";
import { normalizeCcExpenseMerchantKey } from "../ccExpenseCategories.js";
import { backfillGenericTransferUniquePurchases } from "../ccExpenseGenericTransferBackfill.js";
import { InputError, writeHandler } from "../inputError.js";
import { parseBody, queryChoice, queryFlag } from "./shared.js";
import { genericUniqueMerchantSchema, manualIngestRunSchema, syncForceStaleSchema } from "nw-tracker-contracts/requests/sync";
import { lastSyncRunCreatedAt } from "../syncRunLog.js";
import { getGlobalSyncSchedulerSnapshot, notifyGlobalSyncScheduler } from "../globalSyncScheduler.js";
import type { IngestRunKind } from "nw-tracker-contracts";
import { inFlightIngestRun, latestStartedIngestRun, type IngestRunRow } from "../ingestRuns.js";
import { ingestSchedulerEnabled, startManualIngestRun } from "../ingestRunScheduler.js";
import { nextIngestSlotsAfter } from "../ingestRunPolicy.js";
import { buildJobQueuePayload, cancelQueuedJob, retryJob, type JobActionOutcome } from "../jobQueueView.js";

function ingestRunSummary(row: IngestRunRow | null) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    reason: row.reason,
    requested_at: row.requested_at,
    finished_at: row.finished_at,
    failed_steps: row.failed_steps,
    error: row.error,
  };
}

/** The ingest runs the import sync page shows: the one in flight, the latest of each kind, the next slots. */
function ingestRunsStatusPayload(now: Date) {
  const next = nextIngestSlotsAfter(now);
  return {
    scheduler_enabled: ingestSchedulerEnabled(),
    in_flight: ingestRunSummary(inFlightIngestRun()),
    kinds: (["hourly", "nightly"] as const satisfies readonly IngestRunKind[]).map((kind) => ({
      kind,
      latest: ingestRunSummary(latestStartedIngestRun(kind)),
      next_slot_at: next[kind].toISOString(),
    })),
  };
}

/**
 * The file a documents request names: `:accountId` (a positive integer), `:month` (`YYYY-MM`) and
 * `?slot=clp|usd` pick one coverage column and its month's file; malformed → 400, no such column
 * or no file that month → 404 (`InputError`, answered by the terminal error middleware).
 */
function documentFileFromReq(req: express.Request): ImportSyncDocumentFile {
  const rawId = String(req.params.accountId ?? "");
  if (!/^[1-9]\d*$/.test(rawId)) throw new InputError("accountId must be a positive integer");
  const month = String(req.params.month ?? "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new InputError("month must be YYYY-MM");
  const rawSlot = req.query.slot;
  let slot: (typeof IMPORT_SYNC_DOCUMENT_SLOTS)[number] | null = null;
  if (rawSlot !== undefined) {
    const found = IMPORT_SYNC_DOCUMENT_SLOTS.find((s) => s === rawSlot);
    if (!found) throw new InputError(`slot must be one of ${IMPORT_SYNC_DOCUMENT_SLOTS.join(", ")}`);
    slot = found;
  }
  return resolveImportSyncDocumentFile(resolveImportSyncDocumentColumn(Number(rawId), slot), month);
}

export function registerSyncRoutes(app: express.Express): void {
app.get("/api/sync/status", (_req, res) => {
  res.json({
    ...syncStatusPayload(),
    scheduler: getGlobalSyncSchedulerSnapshot(),
    last_sync_at: lastSyncRunCreatedAt(),
  });
});

app.post("/api/sync/force-stale", writeHandler((req, res) => {
  const { source } = parseBody(syncForceStaleSchema, req);
  if (!isGlobalSyncSource(source)) {
    res.status(400).json({ error: "invalid_source" });
    return;
  }
  forceSyncSourceStale(source);
  notifyGlobalSyncScheduler();
  res.json({
    ...syncStatusPayload(),
    scheduler: getGlobalSyncSchedulerSnapshot(),
    last_sync_at: lastSyncRunCreatedAt(),
  });
}));

app.get("/api/import-sync/ingest-runs", (_req, res) => {
  res.json(ingestRunsStatusPayload(new Date()));
});

// Run the hourly poll or the nightly now (a mail that just landed): queued at once, started as
// soon as the ingest service is free.
app.post("/api/import-sync/ingest-runs", writeHandler((req, res) => {
  const { kind } = parseBody(manualIngestRunSchema, req);
  const outcome = startManualIngestRun(kind, new Date());
  if (outcome.status === "refused") {
    res.status(409).json({ error: outcome.message, reason: outcome.reason });
    return;
  }
  res.status(202).json(ingestRunsStatusPayload(new Date()));
}));

// The job queue (docs/job-queue-plan.md): running, waiting (and why), recent; cancel a queued job, retry a failed run.
app.get("/api/import-sync/jobs", (_req, res) => {
  res.json(buildJobQueuePayload(new Date()));
});

const jobAction = (action: (id: number, now: Date) => JobActionOutcome) => (req: express.Request, res: express.Response) => {
  const id = Number(req.params.id);
  const outcome = Number.isInteger(id) && id > 0 ? action(id, new Date()) : ({ ok: false, status: 404, message: `No job ${req.params.id}` } as const);
  if (!outcome.ok) {
    res.status(outcome.status).json({ error: outcome.message });
    return;
  }
  res.json(buildJobQueuePayload(new Date()));
};
app.post("/api/import-sync/jobs/:id/cancel", jobAction(cancelQueuedJob));
app.post("/api/import-sync/jobs/:id/retry", jobAction(retryJob));

app.get("/api/import-sync/document-coverage", (_req, res) => {
  res.json(buildImportSyncDocumentCoveragePayload());
});

// A coverage cell's source file itself (the page's PDF viewer, or a download), resolved on the
// server from the column and month: the only request path that reads those files. A thrown
// `InputError` answers its status through the terminal error middleware.
const DOCUMENT_FILE_HEADERS = [
  "Content-Type",
  "Content-Disposition",
  "X-Content-Type-Options",
  "Cache-Control",
  "Cross-Origin-Resource-Policy",
  "Content-Security-Policy",
] as const;
/** What `send` may have set before failing. */
const SEND_HEADERS = ["ETag", "Last-Modified", "Accept-Ranges", "Content-Range", "Content-Length"] as const;
app.get("/api/import-sync/documents/:accountId/:month/file", (req, res, next) => {
  const download = queryFlag(req, res, "download");
  if (download == null) return;
  const file = documentFileFromReq(req);
  const headers: Record<(typeof DOCUMENT_FILE_HEADERS)[number], string> = {
    "Content-Type": importSyncDocumentContentType(file.preview_kind),
    "Content-Disposition": importSyncDocumentContentDisposition(download ? "attachment" : "inline", file.file_name),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "frame-ancestors 'self'",
  };
  for (const name of DOCUMENT_FILE_HEADERS) res.setHeader(name, headers[name]);
  // The path is the server's own, checked inside the document folders, so a dot folder on it is served.
  res.sendFile(file.abs_path, { dotfiles: "allow", cacheControl: false }, (err?: Error) => {
    if (!err) return;
    const failure = documentSendFailure(err as Error & { code?: string; status?: number }, res.headersSent);
    if (failure.action === "ignore") return;
    if (failure.action === "destroy") {
      res.destroy(err);
      return;
    }
    for (const name of [...DOCUMENT_FILE_HEADERS, ...SEND_HEADERS]) res.removeHeader(name);
    if (failure.action === "not_found") {
      res.status(404).json({ error: `${file.file_name} is no longer on disk` });
      return;
    }
    if (failure.action === "client_error") {
      for (const [name, value] of Object.entries(failure.headers)) res.setHeader(name, value);
      res.status(failure.status).json({ error: err.message });
      return;
    }
    next(err);
  });
});

// A coverage cell's workbook as displayed text, sheet by sheet; a PDF is a 400, over 20 MB or 200 000 cells a 413.
app.get("/api/import-sync/documents/:accountId/:month/sheet", (req, res) => {
  res.json(readImportSyncSheetPreview(documentFileFromReq(req).abs_path));
});

app.get("/api/import-sync/generic-unique-merchants", (_req, res) => {
  res.json({ merchants: listExpenseGenericUniqueMerchants() });
});

app.post("/api/import-sync/generic-unique-merchants", writeHandler((req, res) => {
  const merchantKey = normalizeCcExpenseMerchantKey(parseBody(genericUniqueMerchantSchema, req).merchant);
  if (!merchantKey) {
    res.status(400).json({ error: "merchant required" });
    return;
  }
  // A key already listed is an `InputError` → 409; a failing backfill is a 500.
  const row = createExpenseGenericUniqueMerchant(merchantKey);
  const backfill = backfillGenericTransferUniquePurchases();
  res.json({ row, backfill });
}));

app.patch("/api/import-sync/generic-unique-merchants/:id", writeHandler((req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const merchantKey = normalizeCcExpenseMerchantKey(parseBody(genericUniqueMerchantSchema, req).merchant);
  if (!merchantKey) {
    res.status(400).json({ error: "merchant required" });
    return;
  }
  // An id that is not listed is an `InputError` → 404, a key another row holds → 409.
  const row = updateExpenseGenericUniqueMerchant(id, merchantKey);
  const backfill = backfillGenericTransferUniquePurchases();
  res.json({ row, backfill });
}));

app.delete("/api/import-sync/generic-unique-merchants/:id", writeHandler((req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  deleteExpenseGenericUniqueMerchant(id);
  res.status(204).send();
}));

app.get("/api/messages/unread-count", (_req, res) => {
  res.json({ count: unreadNotificationCount() });
});

app.get("/api/messages", (req, res) => {
  const kind = queryChoice(req, res, "kind", ["notification", "log"] as const, "notification");
  if (kind == null) return;
  res.json({ messages: listAppMessages(kind) });
});

app.post("/api/messages/mark-read", (_req, res) => {
  const marked = markAllNotificationsRead();
  res.json({ marked });
});

/**
 * Terminal error handler: route throws (sync or via asyncHandler) return JSON instead of
 * Express's default HTML stack-trace page, and the process stays up.
 */
}
