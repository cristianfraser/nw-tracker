/** Credit-card installments, purchases, statement lines, web-paste/PDF imports, config. Split verbatim from index.ts; paths unchanged. */
import express from "express";
import { accountBucketKindSlug, bucketSlugForAccountId } from "../accountBucket.js";
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
import { documentImportSpecsForAccount } from "../accountDocumentRegistry.js";
import {
  importAccountDocument,
  importCcStatementPdfUpload,
  importCcWebPaste,
  importCuentaVistaWebPaste,
  importCheckingCartolaXlsx,
  assertCheckingUploadAccount,
  importCheckingCartolaFromRecentXlsxUpload,
} from "../accountImports.js";
import { bankAccountMovementsKind } from "nw-tracker-contracts";
import { applyBankAccountMovements } from "../bankAccountMovementsApply.js";
import { requestFeederParse } from "../ingestFeeder.js";
import { uploadFields, uploadSingle } from "../uploadMiddleware.js";
import { accountIdFromReq, asyncHandler } from "./shared.js";

export function registerCreditCardRoutes(app: express.Express): void {
app.patch("/api/accounts/:id/cc-purchases/:purchaseId", (req, res) => {
  const id = accountIdFromReq(req);
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
  const id = accountIdFromReq(req);
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
  const id = accountIdFromReq(req);
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
  const id = accountIdFromReq(req);
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
  const id = accountIdFromReq(req);
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
  const id = accountIdFromReq(req);
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
  const id = accountIdFromReq(req);
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
  asyncHandler(async (req, res) => {
    const id = accountIdFromReq(req);
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
      res.json(await importCcStatementPdfUpload(id, uploads));
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "import failed" });
    }
  })
);

app.post(
  "/api/accounts/:id/imports/checking-recent-xlsx",
  uploadSingle("file") as unknown as express.RequestHandler,
  // The ingest service decodes the workbook (`/parse/santander.checking_xlsx`); a monthly cartola
  // uploaded here instead (not an «últimos movimientos» workbook) stays on the server's own path
  // until the cartolas move to ingest.
  asyncHandler(async (req, res) => {
    const id = accountIdFromReq(req);
    const f = req.file;
    if (!f) {
      res.status(400).json({ error: "file is required" });
      return;
    }
    try {
      assertCheckingUploadAccount(id);
      const parsed = await requestFeederParse("santander.checking_xlsx", f.buffer, f.originalname);
      if (parsed.status === "unavailable") {
        res.status(503).json({ error: `The file could not be read: ${parsed.message}` });
        return;
      }
      if (parsed.status === "unreadable") {
        res.status(400).json({ error: parsed.message });
        return;
      }
      if (parsed.status === "not_this_format") {
        res.json(await importCheckingCartolaFromRecentXlsxUpload(id, f.buffer, f.originalname));
        return;
      }
      if (parsed.result.kind !== bankAccountMovementsKind.kind || parsed.result.schema_version !== bankAccountMovementsKind.schema_version) {
        throw new Error(`ingest answered ${parsed.result.kind} v${parsed.result.schema_version}, not ${bankAccountMovementsKind.kind}`);
      }
      const payload = bankAccountMovementsKind.payload.parse(parsed.result.payload);
      const { account_id: _accountId, ...applied } = applyBankAccountMovements(payload, f.originalname);
      res.json({ format: "ultimos_movimientos" as const, ...applied, parse_errors: payload.rejected_rows });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "import failed" });
    }
  })
);

app.post(
  "/api/accounts/:id/imports/checking-cartola-xlsx",
  uploadSingle("file") as unknown as express.RequestHandler,
  asyncHandler(async (req, res) => {
    const id = accountIdFromReq(req);
    const f = req.file;
    if (!f) {
      res.status(400).json({ error: "file is required" });
      return;
    }
    const replaceMonth =
      typeof req.query.replaceMonth === "string" ? req.query.replaceMonth : undefined;
    try {
      res.json(await importCheckingCartolaXlsx(id, f.buffer, f.originalname, { replaceMonth }));
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "import failed" });
    }
  })
);

app.post(
  "/api/accounts/:id/imports/document",
  uploadSingle("file") as unknown as express.RequestHandler,
  (req, res) => {
    const id = accountIdFromReq(req);
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
  const id = accountIdFromReq(req);
  if (!isCreditCardAccountId(id)) {
    res.status(404).json({ error: "not a credit-card account" });
    return;
  }
  res.json({ config: getCreditCardAccountConfig(id) });
});

app.patch("/api/accounts/:id/credit-card-config", (req, res) => {
  const id = accountIdFromReq(req);
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
