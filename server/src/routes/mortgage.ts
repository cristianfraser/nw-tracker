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
import { buildMortgageGroupGlance, mortgageGroupPrepayBlock } from "../mortgageGroupGlance.js";
import { buildLiabilitiesGlance } from "../liabilitiesGlance.js";
import { requestDisplayUnit } from "../displayUnits.js";
import { timeHeavyAsync } from "../heavyWork.js";
import { accountIdFromReq, asyncHandler } from "./shared.js";

export function registerMortgageRoutes(app: express.Express): void {
  // UF-timing reminder for the CC-paid Depto mortgage cuota (global toast). Cheap indexed
  // lookups only — no aggregation cache. Sync handler (better-sqlite3 is synchronous).
  app.get("/api/reminders/mortgage-uf", (_req, res) => {
    res.json(buildMortgageUfReminder());
  });

// The mortgage group page (`mortgageGroupGlance.ts`): every loan of the group, summed in `unit`.
app.get("/api/portfolio-groups/:slug/mortgage-glance", asyncHandler(async (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  const unit = requestDisplayUnit(req.query, { surface: "/api/portfolio-groups/:slug/mortgage-glance" });
  const payload = await timeHeavyAsync(`mortgage.group_glance ${slug} ${unit}`, () => buildMortgageGroupGlance(slug, unit));
  if (!payload) {
    res.status(404).json({ error: "not a mortgage group" });
    return;
  }
  res.json(payload);
}));

// The Liabilities page (`liabilitiesGlance.ts`): the card and mortgage groups' totals in `unit`.
app.get("/api/portfolio-groups/:slug/liabilities-glance", asyncHandler(async (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  const unit = requestDisplayUnit(req.query, { surface: "/api/portfolio-groups/:slug/liabilities-glance" });
  const payload = await timeHeavyAsync(`liabilities.glance ${slug} ${unit}`, () => buildLiabilitiesGlance(slug, unit));
  if (!payload) {
    res.status(404).json({ error: "not the liabilities root" });
    return;
  }
  res.json(payload);
}));

// `?benchmark=<slug>&unit=`: the merged payments list's prepaid-vs-invested column (`null`: no
// payment above the minimum). Apart from the page payload, as on the loan page.
app.get("/api/portfolio-groups/:slug/mortgage-prepayments", (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  const benchmark = typeof req.query.benchmark === "string" ? req.query.benchmark : "";
  const unit = requestDisplayUnit(req.query, { surface: "/api/portfolio-groups/:slug/mortgage-prepayments" });
  const block = mortgageGroupPrepayBlock(slug, benchmark, unit);
  if (block === undefined) {
    res.status(400).json({ error: "not a mortgage group or unknown benchmark" });
    return;
  }
  res.json(block);
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
