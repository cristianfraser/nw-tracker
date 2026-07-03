/** Global sync status/force, import-sync admin, messages, bank-statement stub. Split verbatim from index.ts; paths unchanged. */
import express from "express";
import { db } from "../db.js";
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
  createCcExpenseGenericUniqueMerchant,
  deleteCcExpenseGenericUniqueMerchant,
  listCcExpenseGenericUniqueMerchants,
  updateCcExpenseGenericUniqueMerchant,
} from "../ccExpenseGenericUniqueMerchants.js";
import { normalizeCcExpenseMerchantKey } from "../ccExpenseCategories.js";
import { backfillGenericTransferUniquePurchases } from "../ccExpenseGenericTransferBackfill.js";
import { lastSyncRunCreatedAt } from "../syncRunLog.js";
import { getGlobalSyncSchedulerSnapshot, notifyGlobalSyncScheduler } from "../globalSyncScheduler.js";
import { isOptionalString } from "../requestValidation.js";

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

app.get("/api/import-sync/document-coverage", (_req, res) => {
  res.json(buildImportSyncDocumentCoveragePayload());
});

app.get("/api/import-sync/generic-unique-merchants", (_req, res) => {
  res.json({ merchants: listCcExpenseGenericUniqueMerchants() });
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
    const row = createCcExpenseGenericUniqueMerchant(merchantKey);
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
    const row = updateCcExpenseGenericUniqueMerchant(id, merchantKey);
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
    deleteCcExpenseGenericUniqueMerchant(id);
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

/** Placeholder for future bank CSV / PDF pipeline */
app.post("/api/imports/bank-statement", (req, res) => {
  const { filename, raw_text } = req.body as { filename?: unknown; raw_text?: unknown };
  if (!isOptionalString(filename) || !isOptionalString(raw_text)) {
    res.status(400).json({ error: "filename and raw_text must be strings" });
    return;
  }
  const r = db
    .prepare(
      `INSERT INTO import_batches (kind, filename, status, raw_text) VALUES ('bank_statement', ?, 'pending', ?)`
    )
    .run(filename ?? null, raw_text ?? null);
  res.status(201).json({ id: Number(r.lastInsertRowid), status: "pending" });
});

/**
 * Terminal error handler: route throws (sync or via asyncHandler) return JSON instead of
 * Express's default HTML stack-trace page, and the process stays up.
 */
}
