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
  isLegacyEquityEodSyncSource,
  syncStatusPayload,
} from "../globalSyncStale.js";
import { buildImportSyncDocumentCoveragePayload } from "../importSyncDocumentCoverage.js";
import {
  createExpenseGenericUniqueMerchant,
  deleteExpenseGenericUniqueMerchant,
  listExpenseGenericUniqueMerchants,
  updateExpenseGenericUniqueMerchant,
} from "../expenseGenericUniqueMerchants.js";
import { normalizeCcExpenseMerchantKey } from "../ccExpenseCategories.js";
import { backfillGenericTransferUniquePurchases } from "../ccExpenseGenericTransferBackfill.js";
import { lastSyncRunCreatedAt } from "../syncRunLog.js";
import { getGlobalSyncSchedulerSnapshot, notifyGlobalSyncScheduler } from "../globalSyncScheduler.js";
import { INGEST_RUN_KINDS, type IngestRunKind } from "nw-tracker-contracts";
import { inFlightIngestRun, latestStartedIngestRun, type IngestRunRow } from "../ingestRuns.js";
import { ingestSchedulerEnabled, startManualIngestRun } from "../ingestRunScheduler.js";
import { nextIngestSlotsAfter } from "../ingestRunPolicy.js";

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

export function registerSyncRoutes(app: express.Express): void {
app.get("/api/sync/status", (_req, res) => {
  res.json({
    ...syncStatusPayload(),
    scheduler: getGlobalSyncSchedulerSnapshot(),
    last_sync_at: lastSyncRunCreatedAt(),
  });
});

app.post("/api/sync/force-stale", (req, res) => {
  const source = typeof req.body?.source === "string" ? req.body.source.trim() : "";
  if (isLegacyEquityEodSyncSource(source)) {
    forceSyncSourceStale("stocks_nyse");
    forceSyncSourceStale("stocks_santiago");
    forceSyncSourceStale("crypto_eod");
  } else if (!isGlobalSyncSource(source)) {
    res.status(400).json({ error: "invalid_source" });
    return;
  } else {
    forceSyncSourceStale(source);
  }
  notifyGlobalSyncScheduler();
  res.json({
    ...syncStatusPayload(),
    scheduler: getGlobalSyncSchedulerSnapshot(),
    last_sync_at: lastSyncRunCreatedAt(),
  });
});

app.get("/api/import-sync/ingest-runs", (_req, res) => {
  res.json(ingestRunsStatusPayload(new Date()));
});

// Run the hourly poll or the nightly now (a mail that just landed): queued at once, started as
// soon as the ingest service is free.
app.post("/api/import-sync/ingest-runs", (req, res) => {
  const kind = typeof req.body?.kind === "string" ? req.body.kind : "";
  if (!(INGEST_RUN_KINDS as readonly string[]).includes(kind)) {
    res.status(400).json({ error: `Unknown ingest run kind: ${kind || "(none)"}` });
    return;
  }
  const outcome = startManualIngestRun(kind as IngestRunKind, new Date());
  if (outcome.status === "refused") {
    res.status(409).json({ error: outcome.message, reason: outcome.reason });
    return;
  }
  res.status(202).json(ingestRunsStatusPayload(new Date()));
});

app.get("/api/import-sync/document-coverage", (_req, res) => {
  res.json(buildImportSyncDocumentCoveragePayload());
});

app.get("/api/import-sync/generic-unique-merchants", (_req, res) => {
  res.json({ merchants: listExpenseGenericUniqueMerchants() });
});

app.post("/api/import-sync/generic-unique-merchants", (req, res) => {
  const raw = req.body?.merchant;
  if (typeof raw !== "string") {
    res.status(400).json({ error: "merchant required" });
    return;
  }
  const merchantKey = normalizeCcExpenseMerchantKey(raw);
  if (!merchantKey) {
    res.status(400).json({ error: "merchant required" });
    return;
  }
  try {
    const row = createExpenseGenericUniqueMerchant(merchantKey);
    const backfill = backfillGenericTransferUniquePurchases();
    res.json({ row, backfill });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(msg.includes("already exists") ? 409 : 400).json({ error: msg });
  }
});

app.patch("/api/import-sync/generic-unique-merchants/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const raw = req.body?.merchant;
  if (typeof raw !== "string") {
    res.status(400).json({ error: "merchant required" });
    return;
  }
  const merchantKey = normalizeCcExpenseMerchantKey(raw);
  if (!merchantKey) {
    res.status(400).json({ error: "merchant required" });
    return;
  }
  try {
    const row = updateExpenseGenericUniqueMerchant(id, merchantKey);
    const backfill = backfillGenericTransferUniquePurchases();
    res.json({ row, backfill });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg === "not found" ? 404 : msg.includes("already exists") ? 409 : 400;
    res.status(status).json({ error: msg });
  }
});

app.delete("/api/import-sync/generic-unique-merchants/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  try {
    deleteExpenseGenericUniqueMerchant(id);
    res.status(204).send();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(msg === "not found" ? 404 : 400).json({ error: msg });
  }
});

app.get("/api/messages/unread-count", (_req, res) => {
  res.json({ count: unreadNotificationCount() });
});

app.get("/api/messages", (req, res) => {
  const kind = req.query.kind === "log" ? "log" : "notification";
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
