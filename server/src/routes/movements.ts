/** Manual movement create, valuations upsert, aggregation cache clear. Split verbatim from index.ts; paths unchanged. */
import express from "express";
import { accountRowForId } from "../accountRowForMovement.js";
import { validateMovementCreate } from "../movementUnitsPolicy.js";
import { accountBucketKindSlug } from "../accountBucket.js";
import { db } from "../db.js";
import { clearAggregationCache, invalidateAggregationForAccountDate } from "../aggregationCache.js";
import { supersedeImportedCheckingRowsForTransfer } from "../checkingTransferLegReconcile.js";
import { isCheckingLedgerAnchorNote, maybeSyncCheckingLedgerAnchor } from "../checkingCartolaBalances.js";
import { isFiniteNumber, isYmdString } from "../requestValidation.js";
import { operationalAccountIdFromReq } from "./shared.js";

export function registerMovementsRoutes(app: express.Express): void {
app.post("/api/accounts/:id/movements", (req, res) => {
  const accountId = operationalAccountIdFromReq(req);
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
           account_id, from_account_id, to_account_id, amount_clp, occurred_on, note,
           units_delta, flow_kind, amount_usd, ticker
         ) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        validated.from_account_id,
        validated.to_account_id,
        validated.amount_clp,
        validated.occurred_on,
        validated.note,
        validated.units_delta,
        validated.flow_kind,
        validated.amount_usd,
        validated.ticker
      );
    const id = Number(r.lastInsertRowid);
    invalidateAggregationForAccountDate(validated.from_account_id, validated.occurred_on);
    invalidateAggregationForAccountDate(validated.to_account_id, validated.occurred_on);
    // Reverse dedup: if a matching checking bank row was already imported, this transfer supersedes it.
    const superseded = supersedeImportedCheckingRowsForTransfer(
      validated.from_account_id,
      validated.to_account_id,
      validated.amount_clp,
      validated.occurred_on
    );
    res.status(201).json({
      id,
      from_account_id: validated.from_account_id,
      to_account_id: validated.to_account_id,
      units_delta: validated.units_delta,
      flow_kind: validated.flow_kind,
      superseded_imported_checking_ids: superseded.removed_ids,
    });
    return;
  }
  if (validated.mode === "brokerage") {
    const r = db
      .prepare(
        `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta, flow_kind, amount_usd, ticker)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        accountId,
        validated.amount_clp,
        validated.occurred_on,
        validated.note,
        validated.units_delta,
        validated.flow_kind,
        validated.amount_usd,
        validated.ticker
      );
    invalidateAggregationForAccountDate(accountId, validated.occurred_on);
    res.status(201).json({
      id: Number(r.lastInsertRowid),
      units_delta: validated.units_delta,
      flow_kind: validated.flow_kind,
    });
    return;
  }
  const { amount_clp, occurred_on, note, units_delta } = validated;
  const r = db
    .prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta) VALUES (?, ?, ?, ?, ?)`
    )
    .run(accountId, amount_clp, occurred_on, note, units_delta);
  const bucketKind = accountBucketKindSlug(account.bucket_slug);
  if (!isCheckingLedgerAnchorNote(note)) {
    maybeSyncCheckingLedgerAnchor(accountId, bucketKind);
  }
  invalidateAggregationForAccountDate(accountId, occurred_on);
  res.status(201).json({ id: Number(r.lastInsertRowid), units_delta });
});

app.get("/api/accounts/:id/valuations", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  const rows = db
    .prepare(
      `SELECT id, as_of_date, value_clp FROM valuations WHERE account_id = ? ORDER BY as_of_date DESC`
    )
    .all(id);
  res.json({ valuations: rows });
});

app.post("/api/accounts/:id/valuations", (req, res) => {
  const accountId = operationalAccountIdFromReq(req);
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
  db.prepare(
    `INSERT INTO valuations (account_id, as_of_date, value_clp) VALUES (?, ?, ?)
     ON CONFLICT(account_id, as_of_date) DO UPDATE SET value_clp = excluded.value_clp`
  ).run(accountId, as_of_date, value_clp);
  invalidateAggregationForAccountDate(accountId, as_of_date);
  res.json({ ok: true });
});

app.post("/api/panel/cache/aggregation/clear", (_req, res) => {
  clearAggregationCache();
  res.json({ ok: true });
});

/** Home/group card strip shape only (accounts + layout; no valuation TS). */
}
