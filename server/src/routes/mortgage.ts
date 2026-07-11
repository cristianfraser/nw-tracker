/** Mortgage ledger + payment preview/commit. Split verbatim from index.ts; paths unchanged. */
import { loadDeptoLedgerFromMovements } from "../deptoLedgerFromMovements.js";
import express from "express";
import {
  commitMortgagePayment,
  parseMortgagePaymentBody,
  previewMortgagePayment,
} from "../mortgagePaymentCreate.js";
import { isDeptoMortgagePaymentCuota, mortgageMetaFromSheetRows } from "../deptoDividendosLedger.js";
import { buildDeptoPaymentScenarioRows } from "../mortgageScenarioPayments.js";
import { accountKindSlugForAccountId } from "../accountBucket.js";
import { buildMortgageUfReminder } from "../mortgageUfReminder.js";
import { operationalAccountIdFromReq } from "./shared.js";

export function registerMortgageRoutes(app: express.Express): void {
  // UF-timing reminder for the CC-paid Suecia mortgage cuota (global toast). Cheap indexed
  // lookups only — no aggregation cache. Sync handler (better-sqlite3 is synchronous).
  app.get("/api/reminders/mortgage-uf", (_req, res) => {
    res.json(buildMortgageUfReminder());
  });

app.get("/api/accounts/:id/mortgage-ledger", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  // Behavior kind, not raw asset-group slug — generated DBs use the legacy
  // `parent__kind` slug form (`real_estate__property`) for the same accounts.
  const kindSlug = accountKindSlugForAccountId(id);
  if (!kindSlug) {
    res.status(404).json({ error: "account not found" });
    return;
  }
  if (kindSlug === "property" || kindSlug === "mortgage") {
    const sheetRowsAll = loadDeptoLedgerFromMovements();
    const sheetRows =
      kindSlug === "mortgage"
        ? sheetRowsAll.filter((r) => isDeptoMortgagePaymentCuota(r.cuota))
        : sheetRowsAll;
    const payment_scenarios = buildDeptoPaymentScenarioRows(sheetRowsAll);
    res.json({
      account_id: id,
      has_sheet_rows: sheetRowsAll.length > 0,
      meta: sheetRowsAll.length > 0 ? mortgageMetaFromSheetRows(sheetRowsAll) : null,
      rows: sheetRows,
      payment_scenarios,
    });
    return;
  }
  res.json({
    account_id: id,
    has_sheet_rows: false,
    meta: null,
    rows: [] as unknown[],
  });
});

app.post("/api/accounts/:id/mortgage-payments/preview", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  try {
    const input = parseMortgagePaymentBody(req.body as Record<string, unknown>);
    const preview = previewMortgagePayment(id, input);
    res.json(preview);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/accounts/:id/mortgage-payments", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  try {
    const input = parseMortgagePaymentBody(req.body as Record<string, unknown>);
    const result = commitMortgagePayment(id, input);
    res.status(201).json(result);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** Tarjeta de crédito: cupos desde SQLite (`cc_installment_*` o estados PDF); sin lectura runtime del CSV. */
}
