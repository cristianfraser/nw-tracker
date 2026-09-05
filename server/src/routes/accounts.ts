/** Account CRUD, colors, portfolio groups, detail bundle, monthly performance. Split verbatim from index.ts; paths unchanged. */
import express from "express";
import {
  isResolvablePortfolioGroupSlug,
  normalizeLegacyTabSubgroup,
  portfolioGroupBySlug,
  resolvePortfolioGroupSlugForLegacyTab,
} from "../portfolioGroupTree.js";
import { syncEquityEodFromYahoo } from "../equityEodSync.js";
import {
  createPanelAccount,
  updatePanelAccount,
  type PanelAccountCreateBody,
  type PanelAccountUpdateBody,
} from "../createPanelAccount.js";
import { NOTE_STOCKS_LEGACY } from "../brokerageAcciones.js";
import { prettyRgbTripletForAccountId } from "../chartColorRgb.js";
import { updateAccountColorRgb, updatePortfolioGroupColorRgb } from "../entityColors.js";
import { updateAccountExcludeFromGroupTotals } from "../accountExcludeFromGroupTotals.js";
import { db } from "../db.js";
import { listAccountsForGroupTab, type TsUnit } from "../valuationTimeseries.js";
import { getAccountMonthlyPerformance } from "../accountPerformance.js";
import { listPortfolioGroupAccountsForApi } from "../portfolioGroupAccountsApi.js";
import { buildAccountDetailBundle } from "../accountDetailBundle.js";
import { clearCheckingLedgerAnchor, upsertCheckingLedgerAnchor } from "../checkingCartolaBalances.js";
import { getCheckingCartolaMonths } from "../checkingCartolaMonthSummary.js";
import { creditCardGroupLedgerResponse } from "../creditCardGroupLedger.js";
import { mortgageGroupLedgerResponse } from "../mortgageGroupLedger.js";
import { isPositiveInteger } from "../requestValidation.js";
import { asyncHandler, extraOffsetsFromReq, accountIdFromReq } from "./shared.js";

export function registerAccountsRoutes(app: express.Express): void {
app.get("/api/accounts", asyncHandler(async (req, res) => {
  const portfolioGroupSlug =
    typeof req.query.portfolio_group === "string" ? req.query.portfolio_group.trim() : "";
  if (portfolioGroupSlug) {
    if (!isResolvablePortfolioGroupSlug(portfolioGroupSlug)) {
      res.status(400).json({ error: "unknown portfolio_group" });
      return;
    }
    const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
    const rows = await listPortfolioGroupAccountsForApi(portfolioGroupSlug, includeUsd);
    res.json({ accounts: rows });
    return;
  }

  const groupSlug = req.query.group as string | undefined;
  if (!groupSlug) {
    const rows = db
      .prepare(
        `SELECT a.id, a.name, a.notes, a.created_at, a.exclude_from_group_totals, a.color_rgb,
                g.slug AS bucket_slug, g.label AS bucket_label
         FROM accounts a
         INNER JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE (a.import_key IS NULL OR a.import_key != ?)
           AND g.slug != 'individual_stocks'
         ORDER BY g.sort_order, a.id, a.name`
      )
      .all(NOTE_STOCKS_LEGACY) as Record<string, unknown>[];
    res.json({ accounts: rows });
    return;
  }

  const subRaw = normalizeLegacyTabSubgroup(req.query.subgroup);
  if (subRaw === null) {
    res.status(400).json({ error: "invalid subgroup" });
    return;
  }
  const resolvedSlug =
    resolvePortfolioGroupSlugForLegacyTab(groupSlug, subRaw) ??
    (portfolioGroupBySlug(groupSlug) ? groupSlug : null);
  if (!resolvedSlug) {
    res.status(400).json({ error: "unknown group or subgroup" });
    return;
  }

  const tabRows = listAccountsForGroupTab(resolvedSlug);
  const ids = tabRows.map((r) => r.account_id);
  if (!ids.length) {
    res.json({ accounts: [] });
    return;
  }
  const ph = ids.map(() => "?").join(",");
  const fetched = db
    .prepare(
      `SELECT a.id, a.name, a.notes, a.created_at, a.exclude_from_group_totals, a.color_rgb,
              g.slug AS bucket_slug, g.label AS bucket_label
       FROM accounts a
       INNER JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id IN (${ph})`
    )
    .all(...ids) as Record<string, unknown>[];
  // Preserve the group-tab ordering (bucket-major, valuation desc) — the single ordering authority.
  const byId = new Map(fetched.map((row) => [row.id as number, row]));
  const rows = ids
    .map((id) => byId.get(id))
    .filter((row): row is Record<string, unknown> => row != null);
  res.json({ accounts: rows });
}));

app.post("/api/accounts", asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (body.account != null && typeof body.account === "object") {
    try {
      const result = createPanelAccount(body as PanelAccountCreateBody);
      if (result.ticker) {
        await syncEquityEodFromYahoo([result.ticker], { force: true });
      }
      res.status(201).json(result);
    } catch (e) {
      const err = e as Error & { status?: number };
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
      res.status(status).json({ error: err.message || "create account failed" });
    }
    return;
  }

  const { asset_group_id, name, notes } = body as {
    asset_group_id?: unknown;
    name?: string;
    notes?: string;
  };
  if (!isPositiveInteger(asset_group_id) || !name?.trim()) {
    res.status(400).json({ error: "asset_group_id and name required" });
    return;
  }
  const r = db
    .prepare(
      `INSERT INTO accounts (asset_group_id, name, notes) VALUES (?, ?, ?)`
    )
    .run(asset_group_id, name.trim(), notes ?? null);
  const id = Number(r.lastInsertRowid);
  db.prepare(`UPDATE accounts SET color_rgb = ? WHERE id = ?`).run(prettyRgbTripletForAccountId(id), id);
  res.status(201).json({ id });
}));

app.delete("/api/accounts/:id", (req, res) => {
  const id = accountIdFromReq(req);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  const exists = db.prepare(`SELECT 1 AS o FROM accounts WHERE id = ?`).get(id) as { o: number } | undefined;
  if (!exists) {
    res.status(404).json({ error: "account not found" });
    return;
  }
  try {
    const r = db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    res.json({ ok: true, deleted: r.changes });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toLowerCase().includes("foreign key")) {
      res.status(409).json({
        error:
          "cannot delete account with linked records (movements, valuations, or related references)",
      });
      return;
    }
    res.status(500).json({ error: msg });
  }
});

app.patch("/api/accounts/:id", (req, res) => {
  const id = accountIdFromReq(req);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  try {
    const result = updatePanelAccount(id, (req.body ?? {}) as PanelAccountUpdateBody);
    res.json(result);
  } catch (e) {
    const err = e as Error & { status?: number };
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    res.status(status).json({ error: err.message || "update account failed" });
  }
});

app.patch("/api/accounts/:id/color", (req, res) => {
  const id = accountIdFromReq(req);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  const body = req.body as { color_rgb?: unknown };
  const updated = updateAccountColorRgb(id, body.color_rgb);
  if (!updated) {
    const exists = db.prepare(`SELECT 1 AS o FROM accounts WHERE id = ?`).get(id) as { o: number } | undefined;
    if (!exists) {
      res.status(404).json({ error: "account not found" });
      return;
    }
    res.status(400).json({ error: body.color_rgb === null ? "invalid request" : "invalid color_rgb" });
    return;
  }
  res.json(updated);
});

app.patch("/api/accounts/:id/exclude-from-group-totals", (req, res) => {
  const id = accountIdFromReq(req);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  const body = req.body as { exclude_from_group_totals?: unknown };
  const updated = updateAccountExcludeFromGroupTotals(id, body.exclude_from_group_totals);
  if (!updated) {
    const exists = db.prepare(`SELECT 1 AS o FROM accounts WHERE id = ?`).get(id) as
      | { o: number }
      | undefined;
    if (!exists) {
      res.status(404).json({ error: "account not found" });
      return;
    }
    res.status(400).json({ error: "exclude_from_group_totals must be boolean" });
    return;
  }
  res.json(updated);
});

app.patch("/api/portfolio-groups/:slug/color", (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!slug) {
    res.status(400).json({ error: "slug required" });
    return;
  }
  const body = req.body as { color_rgb?: unknown };
  const updated = updatePortfolioGroupColorRgb(slug, body.color_rgb);
  if (!updated) {
    const exists = db
      .prepare(`SELECT 1 AS o FROM portfolio_groups WHERE slug = ?`)
      .get(slug) as { o: number } | undefined;
    if (!exists) {
      res.status(404).json({ error: "portfolio group not found" });
      return;
    }
    res.status(400).json({ error: "invalid color_rgb" });
    return;
  }
  res.json(updated);
});

app.get("/api/portfolio-groups/:slug/cc-ledger", (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!slug || !isResolvablePortfolioGroupSlug(slug)) {
    res.status(404).json({ error: "portfolio group not found" });
    return;
  }
  const extra = extraOffsetsFromReq(req, res);
  if (extra == null) return;
  res.json(creditCardGroupLedgerResponse(slug, extra));
});

app.get("/api/portfolio-groups/:slug/mortgage-ledger", (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!slug || !isResolvablePortfolioGroupSlug(slug)) {
    res.status(404).json({ error: "portfolio group not found" });
    return;
  }
  res.json(mortgageGroupLedgerResponse(slug));
});

app.get("/api/accounts/:id/detail-bundle", asyncHandler(async (req, res) => {
  const id = accountIdFromReq(req);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const unit: TsUnit = includeUsd ? "usd" : "clp";
  const granularity = req.query.granularity === "daily" ? "daily" : "monthly";
  const extraOffsets = extraOffsetsFromReq(req, res);
  if (extraOffsets == null) return;
  const payload = await buildAccountDetailBundle(id, unit, granularity, extraOffsets);
  if (!payload) {
    res.status(404).json({ error: "account not found" });
    return;
  }
  res.json(payload);
}));

/** Month-on-month P/L from valuations + merged capital flows (not persisted). Empty for `cuenta_corriente`. */
app.get("/api/accounts/:id/performance-monthly", (req, res) => {
  const id = accountIdFromReq(req);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const unit: TsUnit = includeUsd ? "usd" : "clp";
  const payload = getAccountMonthlyPerformance(id, unit);
  if (!payload) {
    res.status(404).json({ error: "account not found" });
    return;
  }
  res.json(payload);
});

/** Cuenta corriente: per-cartola month totals from `checking_cartola_imports` + movements. */
app.put("/api/accounts/:id/checking-ledger-anchor", (req, res) => {
  const accountId = accountIdFromReq(req);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  const payload = getCheckingCartolaMonths(accountId);
  if (!payload) {
    res.status(400).json({ error: "account is not a cash cartola account (cuenta corriente or cuenta vista)" });
    return;
  }
  const body = req.body as { clear?: boolean; amount_clp?: number; occurred_on?: string };
  if (body.clear === true) {
    clearCheckingLedgerAnchor(accountId);
    res.json({
      ledger_anchor: null,
      cartola_derived_anchor: getCheckingCartolaMonths(accountId)?.cartola_derived_anchor ?? null,
    });
    return;
  }
  const amount = body.amount_clp;
  const occurredOn = body.occurred_on;
  if (amount == null || !Number.isFinite(amount)) {
    res.status(400).json({ error: "amount_clp required (number, 0 allowed)" });
    return;
  }
  if (!occurredOn || !/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) {
    res.status(400).json({ error: "occurred_on required (YYYY-MM-DD)" });
    return;
  }
  const saved = upsertCheckingLedgerAnchor(accountId, {
    amount_clp: Math.round(amount),
    occurred_on: occurredOn,
  });
  if (!saved) {
    res.status(400).json({ error: "no cartola saldo final to anchor against" });
    return;
  }
  res.json({
    ledger_anchor: saved,
    cartola_derived_anchor: getCheckingCartolaMonths(accountId)?.cartola_derived_anchor ?? null,
  });
});

/** Inmuebles: dividendos sheet snapshot from SQLite (`depto_dividendos_sheet_rows`, filled at import:excel). */
}
