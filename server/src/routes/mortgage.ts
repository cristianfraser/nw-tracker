/** Mortgage payment preview/commit + UF reminder. Split verbatim from index.ts; paths unchanged. */
import express from "express";
import {
  commitMortgagePayment,
  parseMortgagePaymentBody,
  previewMortgagePayment,
} from "../mortgagePaymentCreate.js";
import { mortgageLedgerRowDto } from "../mortgageLedgerDto.js";
import { buildMortgageUfReminder } from "../mortgageUfReminder.js";
import { writeHandler } from "../inputError.js";
import { accountIdFromReq } from "./shared.js";

export function registerMortgageRoutes(app: express.Express): void {
  // UF-timing reminder for the CC-paid Depto mortgage cuota (global toast). Cheap indexed
  // lookups only — no aggregation cache. Sync handler (better-sqlite3 is synchronous).
  app.get("/api/reminders/mortgage-uf", (_req, res) => {
    res.json(buildMortgageUfReminder());
  });

// A payment the form can fix (a missing figure, components that do not add up, a cuota already
// logged, an account that is no loan) is an `InputError` → 400; a ledger or rate the payment
// cannot be computed from (no UF for the day, a prior row without its appraisal) is a 500.
app.post("/api/accounts/:id/mortgage-payments/preview", writeHandler((req, res) => {
  const id = accountIdFromReq(req);
  const input = parseMortgagePaymentBody((req.body ?? {}) as Record<string, unknown>);
  res.json(previewMortgagePayment(id, input));
}));

app.post("/api/accounts/:id/mortgage-payments", writeHandler((req, res) => {
  const id = accountIdFromReq(req);
  const input = parseMortgagePaymentBody((req.body ?? {}) as Record<string, unknown>);
  const committed = commitMortgagePayment(id, input);
  res.status(201).json({ ...committed, sheet_row: mortgageLedgerRowDto(committed.sheet_row) });
}));

/** Tarjeta de crédito: cupos desde SQLite (`cc_installment_*` o estados PDF); sin lectura runtime del CSV. */
}
