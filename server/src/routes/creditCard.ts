/** Credit-card installments, purchases, statement lines, web-paste/PDF imports, config. Split verbatim from index.ts; paths unchanged. */
import express from "express";
import {
  accountBucketKindSlug,
  accountKindSlugForAccountId,
  bucketSlugForAccountId,
} from "../accountBucket.js";
import {
  convertStatementLineToInstallmentPurchase,
  deleteManualCcInstallmentPurchase,
  updateManualCcInstallmentPurchase,
} from "../ccInstallmentManual.js";
import { deleteCcWebPasteStatementLine } from "../ccStatementLineDelete.js";
import { recomputeCcBillingMonthBalances } from "../ccBillingBalances.js";
import {
  applyCreditCardConfigPatch,
  getCreditCardAccountConfig,
  isCreditCardAccountId,
  parseCreditCardConfigPatch,
} from "../ccAccountConfig.js";
import { loadCreditCardBillingConfig } from "../ccBillingMonth.js";
import { creditCardInstallmentsResponse } from "../creditCardInstallments.js";
import { getCcProxyTickers, setCcProxyTickers } from "../ccInvestmentProxy.js";
import { documentImportSpecsForAccount } from "../accountDocumentRegistry.js";
import {
  importAccountDocument,
  importCcStatementPdfUpload,
  importCcWebPaste,
  importCuentaVistaWebPaste,
  importCheckingCartolaXlsx,
  importCheckingRecentXlsx,
} from "../accountImports.js";
import { uploadFields, uploadSingle } from "../uploadMiddleware.js";
import { extraOffsetsFromReq, operationalAccountIdFromReq, parseProxyTickersParam } from "./shared.js";

export function registerCreditCardRoutes(app: express.Express): void {
app.get("/api/accounts/:id/cc-installments", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  const bucketSlug = bucketSlugForAccountId(id);
  if (!bucketSlug) {
    res.status(404).json({ error: "account not found" });
    return;
  }
  if (accountKindSlugForAccountId(id) !== "credit_card") {
    res.json({
      account_id: id,
      has_installment_ledger: false,
      has_imported_statements: false,
      meta: null,
      purchases: [],
      purchases_completed: [],
      months: [],
      totals: {
        total_remaining_principal_clp: 0,
        next_calendar_month_total_clp: null,
        next_calendar_month: null,
      },
    });
    return;
  }
  const extra = extraOffsetsFromReq(req, res);
  if (extra == null) return;
  const proxyTickers = parseProxyTickersParam(req.query.proxy_tickers);
  res.json(creditCardInstallmentsResponse(id, extra, proxyTickers ?? undefined));
});

app.get("/api/cc-proxy-tickers", (_req, res) => {
  res.json({ tickers: getCcProxyTickers() });
});

app.put("/api/cc-proxy-tickers", (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (!Array.isArray(body.tickers) || !body.tickers.every((t) => typeof t === "string")) {
    res.status(400).json({ error: "tickers must be an array of strings" });
    return;
  }
  const tickers = (body.tickers as string[]).map((t) => t.trim()).filter(Boolean);
  if (tickers.length === 0) {
    res.status(400).json({ error: "tickers must not be empty" });
    return;
  }
  setCcProxyTickers(tickers);
  res.json({ tickers });
});

app.patch("/api/accounts/:id/cc-purchases/:purchaseId", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  const purchaseId = Number(req.params.purchaseId);
  if (!Number.isFinite(purchaseId) || purchaseId <= 0) {
    res.status(400).json({ error: "invalid purchase id" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  try {
    updateManualCcInstallmentPurchase(id, purchaseId, {
      purchase_date: body.purchase_date != null ? String(body.purchase_date) : undefined,
      total_amount_clp:
        body.total_amount_clp != null ? Number(body.total_amount_clp) : undefined,
      cuotas_totales: body.cuotas_totales != null ? Number(body.cuotas_totales) : undefined,
      merchant: body.merchant != null ? String(body.merchant) : undefined,
      description: body.description != null ? String(body.description) : undefined,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "update failed" });
  }
});

app.delete("/api/accounts/:id/cc-purchases/:purchaseId", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  const purchaseId = Number(req.params.purchaseId);
  if (!Number.isFinite(purchaseId) || purchaseId <= 0) {
    res.status(400).json({ error: "invalid purchase id" });
    return;
  }
  try {
    deleteManualCcInstallmentPurchase(id, purchaseId);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "delete failed" });
  }
});

app.delete("/api/accounts/:id/cc-statement-lines/:lineId", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  const lineId = Number(req.params.lineId);
  if (!Number.isFinite(lineId) || lineId <= 0) {
    res.status(400).json({ error: "invalid statement line id" });
    return;
  }
  try {
    deleteCcWebPasteStatementLine(id, lineId);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "delete failed" });
  }
});

app.post("/api/accounts/:id/cc-statement-lines/:lineId/make-installment", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  const lineId = Number(req.params.lineId);
  if (!Number.isFinite(lineId) || lineId <= 0) {
    res.status(400).json({ error: "invalid statement line id" });
    return;
  }
  const cuotas = Number(req.body?.cuotas_totales);
  if (!Number.isFinite(cuotas) || cuotas <= 0) {
    res.status(400).json({ error: "cuotas_totales must be a positive number" });
    return;
  }
  try {
    const result = convertStatementLineToInstallmentPurchase(id, lineId, cuotas);
    res.json({ ok: true, purchase_id: result.id });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "conversion failed" });
  }
});

app.get("/api/accounts/:id/import-specs", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  const bucketSlug = bucketSlugForAccountId(id);
  const bucketKind = bucketSlug ? accountBucketKindSlug(bucketSlug) : "";
  res.json({
    account_id: id,
    bucket_slug: bucketSlug,
    document_imports: documentImportSpecsForAccount(id),
    supports_cc_web_paste: bucketKind === "credit_card",
    supports_cc_statement_pdf: bucketKind === "credit_card",
    supports_checking_recent_xlsx: bucketKind === "cuenta_corriente",
    supports_checking_cartola_xlsx: bucketKind === "cuenta_corriente",
    supports_cuenta_vista_web_paste: bucketKind === "cuenta_vista",
  });
});

app.post("/api/accounts/:id/imports/cc-web-paste", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (!text.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  try {
    res.json(importCcWebPaste(id, text));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "import failed" });
  }
});

app.post("/api/accounts/:id/imports/cuenta-vista-web-paste", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (!text.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  try {
    res.json(importCuentaVistaWebPaste(id, text));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "import failed" });
  }
});

app.post(
  "/api/accounts/:id/imports/cc-statement-pdf",
  uploadFields([
    { name: "clp", maxCount: 1 },
    { name: "usd", maxCount: 1 },
    { name: "file", maxCount: 2 },
  ]) as unknown as express.RequestHandler,
  (req, res) => {
    const id = operationalAccountIdFromReq(req);
    const files = req.files as Record<string, { originalname: string; buffer: Buffer }[]> | undefined;
    const uploads: { originalname: string; buffer: Buffer }[] = [];
    for (const key of ["clp", "usd", "file"] as const) {
      for (const f of files?.[key] ?? []) {
        uploads.push({ originalname: f.originalname, buffer: f.buffer });
      }
    }
    if (!uploads.length) {
      res.status(400).json({ error: "Upload at least one PDF (field clp, usd, or file)" });
      return;
    }
    try {
      res.json(importCcStatementPdfUpload(id, uploads));
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "import failed" });
    }
  }
);

app.post(
  "/api/accounts/:id/imports/checking-recent-xlsx",
  uploadSingle("file") as unknown as express.RequestHandler,
  (req, res) => {
    const id = operationalAccountIdFromReq(req);
    const f = req.file;
    if (!f) {
      res.status(400).json({ error: "file is required" });
      return;
    }
    try {
      res.json(importCheckingRecentXlsx(id, f.buffer, f.originalname));
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "import failed" });
    }
  }
);

app.post(
  "/api/accounts/:id/imports/checking-cartola-xlsx",
  uploadSingle("file") as unknown as express.RequestHandler,
  (req, res) => {
    const id = operationalAccountIdFromReq(req);
    const f = req.file;
    if (!f) {
      res.status(400).json({ error: "file is required" });
      return;
    }
    const replaceMonth =
      typeof req.query.replaceMonth === "string" ? req.query.replaceMonth : undefined;
    try {
      res.json(importCheckingCartolaXlsx(id, f.buffer, f.originalname, { replaceMonth }));
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "import failed" });
    }
  }
);

app.post(
  "/api/accounts/:id/imports/document",
  uploadSingle("file") as unknown as express.RequestHandler,
  (req, res) => {
    const id = operationalAccountIdFromReq(req);
    const f = req.file;
    const type = typeof req.body?.type === "string" ? req.body.type : "";
    if (!f) {
      res.status(400).json({ error: "file is required" });
      return;
    }
    if (!type) {
      res.status(400).json({ error: "type is required" });
      return;
    }
    try {
      res.json(
        importAccountDocument(id, type as "afp_uno_cert", f.buffer, f.originalname, f.mimetype)
      );
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "import failed" });
    }
  }
);

app.get("/api/accounts/:id/credit-card-config", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  if (!isCreditCardAccountId(id)) {
    res.status(404).json({ error: "not a credit-card account" });
    return;
  }
  res.json({ config: getCreditCardAccountConfig(id) });
});

app.patch("/api/accounts/:id/credit-card-config", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  if (!isCreditCardAccountId(id)) {
    res.status(404).json({ error: "not a credit-card account" });
    return;
  }
  let patch;
  try {
    patch = parseCreditCardConfigPatch(req.body);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "invalid body" });
    return;
  }
  const result = applyCreditCardConfigPatch(id, patch);
  if (result.billingCycleChanged) recomputeCcBillingMonthBalances(id);
  res.json({
    config: result.config,
    billing_config: loadCreditCardBillingConfig(id),
  });
});


}
