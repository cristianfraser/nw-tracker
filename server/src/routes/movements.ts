import { isHomeCurrency } from "../displayUnits.js";
import { valuationCurrency, valuationsAreAppraisals } from "../valuationValue.js";
import { accountKindSlugForAccountId } from "../accountBucket.js";
/** Manual movement create, valuations upsert, aggregation cache clear. Split verbatim from index.ts; paths unchanged. */
import express from "express";
import { accountRowForId } from "../accountRowForMovement.js";
import { validateMovementCreate } from "../movementUnitsPolicy.js";
import { accountBucketKindSlug } from "../accountBucket.js";
import { db } from "../db.js";
import { clearAggregationCache } from "../cacheRegistry.js";
import { supersedeImportedCheckingRowsForTransfer } from "../checkingTransferLegReconcile.js";
import { isCheckingLedgerAnchorNote, maybeSyncCheckingLedgerAnchor } from "../checkingCartolaBalances.js";
import { isFiniteNumber, isYmdString } from "../requestValidation.js";
import { accountIdFromReq } from "./shared.js";
import { cryptoEquityTickerForAccount } from "../cryptoValuation.js";
import { assignOptionContract } from "../optionAssignment.js";
import { isOptionContractAccount } from "../optionContracts.js";

export function registerMovementsRoutes(app: express.Express): void {
app.post("/api/accounts/:id/movements", (req, res) => {
  const accountId = accountIdFromReq(req);
  const account = accountRowForId(accountId);
  if (!account) {
    res.status(404).json({ error: "Account not found." });
    return;
  }
  const validated = validateMovementCreate(account, req.body as Record<string, unknown>, accountId);
  if (!validated.ok) {
    res.status(validated.status).json({ error: validated.error });
    return;
  }
  if (validated.mode === "transfer") {
    const r = db
      .prepare(
        `INSERT INTO movements (
           account_id, from_account_id, to_account_id, amount, currency, counter_amount, counter_currency,
           occurred_on, note, units_delta, counter_units_delta, flow_kind
         ) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        validated.from_account_id,
        validated.to_account_id,
        validated.amount,
        validated.currency,
        validated.counter_amount,
        validated.counter_currency,
        validated.occurred_on,
        validated.note,
        validated.units_delta,
        validated.counter_units_delta,
        validated.flow_kind
      );
    const id = Number(r.lastInsertRowid);
    // Reverse dedup: if a matching checking bank row was already imported, this transfer supersedes it.
    // Checking rows are CLP; a non-CLP transfer has no CLP leg to supersede.
    const superseded =
      isHomeCurrency(validated.currency)
        ? supersedeImportedCheckingRowsForTransfer(
            id,
            validated.from_account_id,
            validated.to_account_id,
            validated.amount,
            validated.occurred_on
          )
        : { removed_ids: [] as number[] };
    res.status(201).json({
      id,
      from_account_id: validated.from_account_id,
      to_account_id: validated.to_account_id,
      units_delta: validated.units_delta,
      counter_units_delta: validated.counter_units_delta,
      flow_kind: validated.flow_kind,
      superseded_imported_checking_ids: superseded.removed_ids,
    });
    return;
  }
  if (validated.mode === "brokerage") {
    const r = db
      .prepare(
        `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta, flow_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        accountId,
        validated.amount,
        validated.currency,
        validated.occurred_on,
        validated.note,
        validated.units_delta,
        validated.flow_kind
      );
    res.status(201).json({
      id: Number(r.lastInsertRowid),
      units_delta: validated.units_delta,
      flow_kind: validated.flow_kind,
    });
    return;
  }
  const { amount, currency, occurred_on, note, units_delta } = validated;
  const r = db
    .prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(accountId, amount, currency, occurred_on, note, units_delta);
  const bucketKind = accountBucketKindSlug(account.bucket_slug);
  if (!isCheckingLedgerAnchorNote(note)) {
    maybeSyncCheckingLedgerAnchor(accountId, bucketKind);
  }
  res.status(201).json({ id: Number(r.lastInsertRowid), units_delta });
});

/**
 * An option assignment or exercise on contract account `:id`: the `option_assign` row and the
 * share leg at the strike, written together (`optionAssignment.ts`).
 */
app.post("/api/accounts/:id/option-assignments", (req, res) => {
  const accountId = accountIdFromReq(req);
  if (!isOptionContractAccount(accountId)) {
    res.status(404).json({ error: "Account is not an option contract." });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
  try {
    const result = assignOptionContract({
      contract_account_id: accountId,
      stock_account_id: num(body.stock_account_id),
      cash_account_id: num(body.cash_account_id),
      occurred_on: typeof body.occurred_on === "string" ? body.occurred_on.trim() : "",
      contracts: num(body.contracts),
      note: typeof body.note === "string" ? body.note : null,
    });
    res.status(201).json(result);
  } catch (e) {
    const err = e as Error & { status?: number };
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    res.status(status).json({ error: err.message || "option assignment failed" });
  }
});

app.get("/api/accounts/:id/valuations", (req, res) => {
  const id = accountIdFromReq(req);
  const rows = db
    .prepare(`SELECT id, as_of_date, value, currency FROM valuations WHERE account_id = ? ORDER BY as_of_date DESC`)
    .all(id) as { id: number; as_of_date: string; value: number; currency: string }[];
  // Each row in the currency it is stated in (a property's appraisals in UF).
  for (const r of rows) valuationCurrency(r.currency, "GET /valuations");
  res.json({ valuations: rows });
});

app.post("/api/accounts/:id/valuations", (req, res) => {
  const accountId = accountIdFromReq(req);
  const { as_of_date, value_clp } = req.body as { as_of_date?: unknown; value_clp?: unknown };
  // Validate BEFORE the write: dates are compared lexically everywhere, so one malformed
  // as_of_date row poisons every on-or-before lookup for this account.
  if (!isYmdString(as_of_date)) {
    res.status(400).json({ error: "as_of_date must be YYYY-MM-DD" });
    return;
  }
  if (!isFiniteNumber(value_clp)) {
    res.status(400).json({ error: "value_clp must be a finite number" });
    return;
  }
  // A property's valuations are its appraisals in UF (written with its payments), never pesos.
  if (valuationsAreAppraisals(accountKindSlugForAccountId(accountId) ?? "")) {
    res.status(400).json({ error: "a property's valuations are its UF appraisals; no peso valuations" });
    return;
  }
  // Crypto is marked from units × close × fx only; a stored row would be read by nothing and
  // drift from the mark (the retired `crypto:apply-valuation` rows did).
  if (cryptoEquityTickerForAccount(accountId) != null) {
    res.status(400).json({ error: "crypto accounts are valued from their coin units; no stored valuations" });
    return;
  }
  db.prepare(
    `INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')
     ON CONFLICT(account_id, as_of_date) DO UPDATE SET value = excluded.value, currency = excluded.currency`
  ).run(accountId, as_of_date, value_clp);
  res.json({ ok: true });
});

app.post("/api/panel/cache/aggregation/clear", (_req, res) => {
  clearAggregationCache();
  res.json({ ok: true });
});

/** Home/group card strip shape only (accounts + layout; no valuation TS). */
}
