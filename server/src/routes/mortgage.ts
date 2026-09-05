/** Mortgage payment preview/commit + UF reminder. Split verbatim from index.ts; paths unchanged. */
import express from "express";
import {
  commitMortgagePayment,
  parseMortgagePaymentBody,
  previewMortgagePayment,
} from "../mortgagePaymentCreate.js";
import { buildMortgageUfReminder } from "../mortgageUfReminder.js";
import { accountIdFromReq } from "./shared.js";

export function registerMortgageRoutes(app: express.Express): void {
  // UF-timing reminder for the CC-paid Depto mortgage cuota (global toast). Cheap indexed
  // lookups only — no aggregation cache. Sync handler (better-sqlite3 is synchronous).
  app.get("/api/reminders/mortgage-uf", (_req, res) => {
    res.json(buildMortgageUfReminder());
  });

app.post("/api/accounts/:id/mortgage-payments/preview", (req, res) => {
  const id = accountIdFromReq(req);
  try {
    const input = parseMortgagePaymentBody(req.body as Record<string, unknown>);
    const preview = previewMortgagePayment(id, input);
    res.json(preview);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/accounts/:id/mortgage-payments", (req, res) => {
  const id = accountIdFromReq(req);
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
