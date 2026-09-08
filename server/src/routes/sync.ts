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
