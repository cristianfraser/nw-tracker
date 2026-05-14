import cors from "cors";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getMergedDepositInflowEventsForAccount,
  totalDepositsClpWithStocksSheetFloor,
  totalWithdrawalsClpForAccount,
} from "./accountDeposits.js";
import { getAccountPositionMeta } from "./accountPosition.js";
import {
  accountUsesEquityMtm,
  computeEquityMtmClp,
  computeLatestDisplayedEquityClp,
  equityTickerForAccount,
} from "./brokerageEquityMtm.js";
import { NOTE_STOCKS_LEGACY, type DashboardAccountStats } from "./brokerageAcciones.js";
import {
  loadDeptoDividendosSheetLedger,
  mortgageMetaFromSheetRows,
} from "./deptoDividendosLedger.js";
import { fxRowOnOrBefore } from "./fxRates.js";
import { db } from "./db.js";
import { getMarketSeriesPayload } from "./marketSeries.js";
import {
  getAccountValuationTimeseries,
  getDashboardValuationTimeseries,
  getGroupValuationTimeseries,
  type TsUnit,
} from "./valuationTimeseries.js";
import { getAccountMonthlyPerformance, getGroupMonthlyPerformanceSeries, getStocksLifetimeEarningsSeries } from "./accountPerformance.js";
import { resolveCfraserCsvDir, resolveDeptoDividendosCsvPath } from "./cfraserPaths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

/** Category tree: groups + nested categories */
app.get("/api/meta/asset-tree", (_req, res) => {
  const groups = db
    .prepare(
      `SELECT id, slug, label, sort_order FROM asset_groups ORDER BY sort_order, id`
    )
    .all() as { id: number; slug: string; label: string; sort_order: number }[];

  const cats = db
    .prepare(
      `SELECT id, group_id, slug, label, sort_order FROM categories ORDER BY sort_order, id`
    )
    .all() as { id: number; group_id: number; slug: string; label: string; sort_order: number }[];

  const byGroup = new Map<number, typeof cats>();
  for (const c of cats) {
    const arr = byGroup.get(c.group_id) ?? [];
    arr.push(c);
    byGroup.set(c.group_id, arr);
  }

  res.json({
    groups: groups.map((g) => ({
      ...g,
      categories: byGroup.get(g.id) ?? [],
    })),
  });
});

app.get("/api/accounts", (req, res) => {
  const groupSlug = req.query.group as string | undefined;
  let sql = `
    SELECT a.id, a.name, a.notes, a.created_at,
           c.slug AS category_slug, c.label AS category_label,
           g.slug AS group_slug, g.label AS group_label
    FROM accounts a
    JOIN categories c ON c.id = a.category_id
    JOIN asset_groups g ON g.id = c.group_id
    WHERE (a.notes IS NULL OR a.notes != ?)
      AND (g.slug != 'brokerage' OR c.slug != 'individual_stocks')
  `;
  const params: string[] = [NOTE_STOCKS_LEGACY];
  if (groupSlug) {
    sql += ` AND g.slug = ?`;
    params.push(groupSlug);
  }
  sql += ` ORDER BY g.sort_order, c.sort_order, a.name`;
  const rows = db.prepare(sql).all(...params);
  res.json({ accounts: rows });
});

app.post("/api/accounts", (req, res) => {
  const { category_id, name, notes } = req.body as {
    category_id?: number;
    name?: string;
    notes?: string;
  };
  if (!category_id || !name?.trim()) {
    res.status(400).json({ error: "category_id and name required" });
    return;
  }
  const r = db
    .prepare(
      `INSERT INTO accounts (category_id, name, notes) VALUES (?, ?, ?)`
    )
    .run(category_id, name.trim(), notes ?? null);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

app.get("/api/accounts/:id/valuation-timeseries", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const unit: TsUnit = includeUsd ? "usd" : "clp";
  const granularity = req.query.granularity === "daily" ? "daily" : "monthly";
  const payload = getAccountValuationTimeseries(id, unit, { granularity });
  if (!payload) {
    res.status(404).json({ error: "account not found" });
    return;
  }
  res.json(payload);
});

/** Month-on-month P/L from valuations + merged capital flows (not persisted). Empty for `cuenta_corriente`. */
app.get("/api/accounts/:id/performance-monthly", (req, res) => {
  const id = Number(req.params.id);
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

app.get("/api/accounts/:id/deposit-inflows", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  const exists = db.prepare(`SELECT 1 AS o FROM accounts WHERE id = ?`).get(id) as { o: number } | undefined;
  if (!exists) {
    res.status(404).json({ error: "account not found" });
    return;
  }
  const catRow = db
    .prepare(
      `SELECT c.slug AS category_slug FROM accounts a JOIN categories c ON c.id = a.category_id WHERE a.id = ?`
    )
    .get(id) as { category_slug: string } | undefined;
  const events = getMergedDepositInflowEventsForAccount(id);
  const total_clp = totalDepositsClpWithStocksSheetFloor(id, catRow?.category_slug ?? "");
  let cumulative_clp = 0;
  const events_with_cumulative = events.map((e) => {
    cumulative_clp += e.amt;
    return { occurred_on: e.occurred_on, amt_clp: e.amt, cumulative_clp };
  });
  res.json({
    account_id: id,
    total_clp,
    events: events_with_cumulative,
  });
});

app.get("/api/accounts/:id/summary", (req, res) => {
  const id = Number(req.params.id);
  const withdrawals_clp = totalWithdrawalsClpForAccount(id);
  const cat = db
    .prepare(
      `SELECT c.slug AS category_slug FROM accounts a JOIN categories c ON c.id = a.category_id WHERE a.id = ?`
    )
    .get(id) as { category_slug: string } | undefined;
  const deposits_clp = totalDepositsClpWithStocksSheetFloor(id, cat?.category_slug ?? "");
  const valStmt = db.prepare(
    `SELECT value_clp, as_of_date FROM valuations WHERE account_id = ? ORDER BY as_of_date DESC LIMIT 1`
  );
  const maxEqDateStmt = db.prepare(
    `SELECT max(trade_date) AS md FROM equity_daily WHERE ticker = ?`
  );
  let latest = valStmt.get(id) as { value_clp: number; as_of_date: string } | undefined;
  const eqShown = computeLatestDisplayedEquityClp(id);
  if (eqShown != null) {
    latest = eqShown;
  } else if (!latest || latest.value_clp == null || latest.value_clp === 0) {
    if (accountUsesEquityMtm(id)) {
      const t = equityTickerForAccount(id);
      if (t) {
        const md = maxEqDateStmt.get(t) as { md: string | null };
        if (md?.md) {
          const c = computeEquityMtmClp(id, md.md);
          if (c != null) latest = { value_clp: c, as_of_date: md.md };
        }
      }
    }
  }
  const positionMeta = cat ? getAccountPositionMeta(id, cat.category_slug) : null;
  const v = latest?.value_clp;
  const units = positionMeta?.units;
  const value_per_unit_clp =
    v != null && units != null && units > 0 && Number.isFinite(v) && Number.isFinite(units) ? v / units : null;
  res.json({
    account_id: id,
    category_slug: cat?.category_slug ?? null,
    deposits_clp,
    withdrawals_clp,
    latest_valuation_clp: latest?.value_clp ?? null,
    latest_valuation_date: latest?.as_of_date ?? null,
    position:
      positionMeta != null
        ? {
            ticker: positionMeta.ticker,
            units_kind: positionMeta.units_kind,
            units: positionMeta.units,
            deposited_clp: deposits_clp,
            value_clp: latest?.value_clp ?? null,
            value_as_of: latest?.as_of_date ?? null,
            value_per_unit_clp,
          }
        : null,
  });
});

app.get("/api/accounts/:id/movements", (req, res) => {
  const id = Number(req.params.id);
  const rows = db
    .prepare(
      `SELECT id, amount_clp, occurred_on, note FROM movements WHERE account_id = ? ORDER BY occurred_on DESC, id DESC`
    )
    .all(id);
  res.json({ movements: rows });
});

/** Inmuebles: full “dividendos” sheet from `cfraser/depto-dividendos.csv` (not DB movements). */
app.get("/api/accounts/:id/mortgage-ledger", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  const row = db
    .prepare(
      `SELECT c.slug AS category_slug FROM accounts a JOIN categories c ON c.id = a.category_id WHERE a.id = ?`
    )
    .get(id) as { category_slug: string } | undefined;
  if (!row) {
    res.status(404).json({ error: "account not found" });
    return;
  }
  const csvRel = "cfraser/depto-dividendos.csv";
  if (row.category_slug === "property") {
    const dir = resolveCfraserCsvDir();
    const absCsv = resolveDeptoDividendosCsvPath();
    const sheetRows = loadDeptoDividendosSheetLedger(dir);
    const meta = {
      ...mortgageMetaFromSheetRows(sheetRows, csvRel),
      csv_absolute_path: absCsv,
      csv_file_exists: fs.existsSync(absCsv),
    };
    res.json({
      account_id: id,
      source: "csv" as const,
      meta,
      rows: sheetRows,
    });
    return;
  }
  res.json({
    account_id: id,
    source: "none" as const,
    meta: null,
    rows: [] as unknown[],
  });
});

app.post("/api/accounts/:id/movements", (req, res) => {
  const accountId = Number(req.params.id);
  const { amount_clp, occurred_on, note } = req.body as {
    amount_clp?: number;
    occurred_on?: string;
    note?: string;
  };
  if (
    amount_clp === undefined ||
    amount_clp === null ||
    amount_clp === 0 ||
    !Number.isFinite(amount_clp) ||
    !occurred_on
  ) {
    res.status(400).json({
      error: "amount_clp must be non-zero (positive = deposit, negative = withdrawal) and occurred_on required",
    });
    return;
  }
  const r = db
    .prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note) VALUES (?, ?, ?, ?)`
    )
    .run(accountId, amount_clp, occurred_on, note ?? null);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

app.get("/api/accounts/:id/valuations", (req, res) => {
  const id = Number(req.params.id);
  const rows = db
    .prepare(
      `SELECT id, as_of_date, value_clp FROM valuations WHERE account_id = ? ORDER BY as_of_date DESC`
    )
    .all(id);
  res.json({ valuations: rows });
});

app.post("/api/accounts/:id/valuations", (req, res) => {
  const accountId = Number(req.params.id);
  const { as_of_date, value_clp } = req.body as { as_of_date?: string; value_clp?: number };
  if (!as_of_date || value_clp === undefined || value_clp === null) {
    res.status(400).json({ error: "as_of_date and value_clp required" });
    return;
  }
  db.prepare(
    `INSERT INTO valuations (account_id, as_of_date, value_clp) VALUES (?, ?, ?)
     ON CONFLICT(account_id, as_of_date) DO UPDATE SET value_clp = excluded.value_clp`
  ).run(accountId, as_of_date, value_clp);
  res.json({ ok: true });
});

app.get("/api/dashboard", (req, res) => {
  const accounts = db
    .prepare(
      `
      SELECT a.id, a.name, a.notes,
             g.slug AS group_slug, g.label AS group_label,
             c.slug AS category_slug, c.label AS category_label
      FROM accounts a
      JOIN categories c ON c.id = a.category_id
      JOIN asset_groups g ON g.id = c.group_id
      WHERE (a.notes IS NULL OR a.notes != ?)
        AND (g.slug != 'brokerage' OR c.slug != 'individual_stocks')
      ORDER BY g.sort_order, c.sort_order, a.name
    `
    )
    .all(NOTE_STOCKS_LEGACY) as {
    id: number;
    name: string;
    notes: string | null;
    group_slug: string;
    group_label: string;
    category_slug: string;
    category_label: string;
  }[];

  const valStmt = db.prepare(
    `SELECT value_clp, as_of_date FROM valuations WHERE account_id = ? ORDER BY as_of_date DESC LIMIT 1`
  );
  const maxEqDateStmt = db.prepare(
    `SELECT max(trade_date) AS md FROM equity_daily WHERE ticker = ?`
  );

  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";

  const rowsBuilt: DashboardAccountStats[] = accounts.map((a) => {
    const deposits = totalDepositsClpWithStocksSheetFloor(a.id, a.category_slug);
    let v = valStmt.get(a.id) as { value_clp: number; as_of_date: string } | undefined;
    const eqShown = computeLatestDisplayedEquityClp(a.id);
    if (eqShown != null) {
      v = eqShown;
    } else if (!v || v.value_clp == null || v.value_clp === 0) {
      if (accountUsesEquityMtm(a.id)) {
        const t = equityTickerForAccount(a.id);
        if (t) {
          const md = maxEqDateStmt.get(t) as { md: string | null };
          if (md?.md) {
            const c = computeEquityMtmClp(a.id, md.md);
            if (c != null) v = { value_clp: c, as_of_date: md.md };
          }
        }
      }
    }
    const fxRow = includeUsd ? fxRowOnOrBefore(v?.as_of_date ?? null) : null;
    const current_value_usd =
      includeUsd && v && fxRow ? v.value_clp / fxRow.clp_per_usd : null;
    const fx_date_used = fxRow?.date ?? null;
    const fx_clp_per_usd = fxRow?.clp_per_usd ?? null;
    const positionMeta = getAccountPositionMeta(a.id, a.category_slug);
    const units = positionMeta?.units;
    const valClp = v?.value_clp;
    const value_per_unit_clp =
      valClp != null && units != null && units > 0 && Number.isFinite(valClp) && Number.isFinite(units)
        ? valClp / units
        : null;
    return {
      account_id: a.id,
      name: a.name,
      group_slug: a.group_slug,
      group_label: a.group_label,
      category_slug: a.category_slug,
      category_label: a.category_label,
      deposits_clp: deposits,
      current_value_clp: v?.value_clp ?? null,
      valuation_as_of: v?.as_of_date ?? null,
      current_value_usd,
      fx_clp_per_usd,
      fx_date_used,
      notes: a.notes ?? null,
      position:
        positionMeta != null
          ? {
              ticker: positionMeta.ticker,
              units_kind: positionMeta.units_kind,
              units: positionMeta.units,
              deposited_clp: deposits,
              value_clp: valClp ?? null,
              value_as_of: v?.as_of_date ?? null,
              value_per_unit_clp,
            }
          : null,
    };
  });

  function addToBucket(
    map: Map<string, { clp: number; usd: number }>,
    slug: string,
    clp: number,
    usd: number | null
  ) {
    const cur = map.get(slug) ?? { clp: 0, usd: 0 };
    cur.clp += clp;
    if (usd != null && Number.isFinite(usd)) cur.usd += usd;
    map.set(slug, cur);
  }

  const bucketTotals = new Map<string, { clp: number; usd: number }>();
  for (const r of rowsBuilt) {
    if (r.current_value_clp == null) continue;
    addToBucket(bucketTotals, r.group_slug, r.current_value_clp, includeUsd ? r.current_value_usd : null);
  }

  const getBucket = (slug: string) => bucketTotals.get(slug) ?? { clp: 0, usd: 0 };
  const re = getBucket("real_estate");
  const ret = getBucket("retirement");
  const bro = getBucket("brokerage");
  const cash = getBucket("cash_eqs");
  const cry = getBucket("crypto");
  const lia = getBucket("liabilities");

  const netWorthClp = re.clp + ret.clp + bro.clp + cash.clp + cry.clp;
  const netWorthUsd = includeUsd ? re.usd + ret.usd + bro.usd + cash.usd + cry.usd : null;

  const totalDeposits = rowsBuilt.reduce((s, r) => s + r.deposits_clp, 0);

  const byGroup = new Map<string, { label: string; value_clp: number; value_usd: number }>();
  for (const r of rowsBuilt) {
    if (r.current_value_clp == null) continue;
    const cur = byGroup.get(r.group_slug) ?? {
      label: r.group_label,
      value_clp: 0,
      value_usd: 0,
    };
    cur.value_clp += r.current_value_clp;
    if (r.current_value_usd != null && Number.isFinite(r.current_value_usd)) cur.value_usd += r.current_value_usd;
    byGroup.set(r.group_slug, cur);
  }

  const clientAccounts = rowsBuilt.map(({ notes: _n, ...rest }) => rest);

  res.json({
    totals: {
      net_worth_clp: netWorthClp,
      deposits_clp: totalDeposits,
      real_estate_clp: re.clp,
      retirement_clp: ret.clp,
      brokerage_clp: bro.clp,
      cash_eqs_clp: cash.clp,
      crypto_clp: cry.clp,
      liabilities_clp: lia.clp,
      ...(includeUsd
        ? {
            net_worth_usd: netWorthUsd,
            real_estate_usd: re.usd,
            retirement_usd: ret.usd,
            brokerage_usd: bro.usd,
            cash_eqs_usd: cash.usd,
            crypto_usd: cry.usd,
            liabilities_usd: lia.usd,
          }
        : {}),
    },
    allocation: [...byGroup.entries()].map(([slug, v]) => ({
      group_slug: slug,
      group_label: v.label,
      value_clp: v.value_clp,
      ...(includeUsd ? { value_usd: v.value_usd } : {}),
    })),
    accounts: clientAccounts,
  });
});

/**
 * Valuation time series: main dashboard (no `group`) or per-class tab (`group=retirement|brokerage|…`).
 * Query: include_usd / include_uf → unit (main dashboard UI only uses CLP+USD; UF kept for other consumers).
 */
app.get("/api/dashboard/valuation-timeseries", (req, res) => {
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const includeUf = req.query.include_uf === "1" || req.query.include_uf === "true";
  const unit: TsUnit = includeUsd ? "usd" : includeUf ? "uf" : "clp";

  const group = typeof req.query.group === "string" ? req.query.group.trim() : "";
  if (group) {
    const ok = db.prepare(`SELECT 1 AS o FROM asset_groups WHERE slug = ?`).get(group) as { o: number } | undefined;
    if (!ok) {
      res.status(400).json({ error: "unknown group slug" });
      return;
    }
    res.json(getGroupValuationTimeseries(group, unit));
    return;
  }

  res.json(getDashboardValuationTimeseries(unit));
});

/** SPY+VEA merged: monthly Δ (sum) and cumulative earnings since first month (derived). */
app.get("/api/dashboard/stocks-earnings-monthly", (req, res) => {
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const unit: TsUnit = includeUsd ? "usd" : "clp";
  res.json(getStocksLifetimeEarningsSeries(unit));
});

/** Per-class tab: month P/L bars per account + combined YTD area + ΣΔ line (derived, not stored). */
app.get("/api/groups/:slug/performance-monthly", (req, res) => {
  const slug = typeof req.params.slug === "string" ? req.params.slug.trim() : "";
  const ok = db.prepare(`SELECT 1 AS o FROM asset_groups WHERE slug = ?`).get(slug) as { o: number } | undefined;
  if (!ok) {
    res.status(400).json({ error: "unknown group slug" });
    return;
  }
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const unit: TsUnit = includeUsd ? "usd" : "clp";
  res.json(getGroupMonthlyPerformanceSeries(slug, unit));
});

app.get("/api/accounts/:id/brokerage-flows", (req, res) => {
  const id = Number(req.params.id);
  const rows = db
    .prepare(
      `SELECT id, occurred_on, flow_kind, amount_clp, amount_usd, ticker, note
       FROM brokerage_flows WHERE account_id = ? ORDER BY occurred_on DESC, id DESC`
    )
    .all(id);
  res.json({ flows: rows });
});

app.post("/api/accounts/:id/brokerage-flows", (req, res) => {
  const accountId = Number(req.params.id);
  const { occurred_on, flow_kind, amount_clp, amount_usd, ticker, note } = req.body as {
    occurred_on?: string;
    flow_kind?: string;
    amount_clp?: number;
    amount_usd?: number;
    ticker?: string;
    note?: string;
  };
  const kinds = ["deposit_clp", "compra_usd", "dividend_usd", "withdrawal_clp", "other"];
  if (!occurred_on || !flow_kind || !kinds.includes(flow_kind)) {
    res.status(400).json({ error: "occurred_on and valid flow_kind required" });
    return;
  }
  const clp = amount_clp ?? null;
  const usd = amount_usd ?? null;
  if ((clp == null || clp === 0) && (usd == null || usd === 0)) {
    res.status(400).json({ error: "amount_clp or amount_usd required" });
    return;
  }
  const r = db
    .prepare(
      `INSERT INTO brokerage_flows (account_id, occurred_on, flow_kind, amount_clp, amount_usd, ticker, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(accountId, occurred_on, flow_kind, clp, usd, ticker ?? null, note ?? null);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

app.get("/api/fx/latest", (_req, res) => {
  const row = db
    .prepare(`SELECT date, clp_per_usd FROM fx_daily ORDER BY date DESC LIMIT 1`)
    .get() as { date: string; clp_per_usd: number } | undefined;
  res.json(row ?? null);
});

app.get("/api/fx", (_req, res) => {
  const rows = db
    .prepare(`SELECT date, clp_per_usd FROM fx_daily ORDER BY date DESC LIMIT 365`)
    .all();
  res.json({ rates: rows });
});

/** Upsert FX: body { date: 'YYYY-MM-DD', clp_per_usd: number } */
app.post("/api/fx", (req, res) => {
  const { date, clp_per_usd } = req.body as { date?: string; clp_per_usd?: number };
  if (!date || !clp_per_usd || clp_per_usd <= 0) {
    res.status(400).json({ error: "date and positive clp_per_usd required" });
    return;
  }
  db.prepare(
    `INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, ?)
     ON CONFLICT(date) DO UPDATE SET clp_per_usd = excluded.clp_per_usd`
  ).run(date, clp_per_usd);
  res.json({ ok: true });
});

app.get("/api/uf/latest", (_req, res) => {
  const row = db
    .prepare(`SELECT date, clp_per_uf FROM uf_daily ORDER BY date DESC LIMIT 1`)
    .get() as { date: string; clp_per_uf: number } | undefined;
  res.json(row ?? null);
});

app.get("/api/uf", (_req, res) => {
  const rows = db.prepare(`SELECT date, clp_per_uf FROM uf_daily ORDER BY date DESC LIMIT 500`).all();
  res.json({ rates: rows });
});

/** Upsert UF (CLF): body { date: 'YYYY-MM-DD', clp_per_uf: number } CLP per 1 UF */
app.post("/api/uf", (req, res) => {
  const { date, clp_per_uf } = req.body as { date?: string; clp_per_uf?: number };
  if (!date || !clp_per_uf || clp_per_uf <= 0) {
    res.status(400).json({ error: "date and positive clp_per_uf required" });
    return;
  }
  db.prepare(
    `INSERT INTO uf_daily (date, clp_per_uf) VALUES (?, ?)
     ON CONFLICT(date) DO UPDATE SET clp_per_uf = excluded.clp_per_uf`
  ).run(date, clp_per_uf);
  res.json({ ok: true });
});

app.get("/api/market-series", (_req, res) => {
  res.json(getMarketSeriesPayload());
});

app.get("/api/income", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, amount_clp, received_on, source, note FROM income_entries ORDER BY received_on DESC, id DESC`
    )
    .all();
  res.json({ income: rows });
});

app.post("/api/income", (req, res) => {
  const { amount_clp, received_on, source, note } = req.body as {
    amount_clp?: number;
    received_on?: string;
    source?: string;
    note?: string;
  };
  if (amount_clp == null || !received_on) {
    res.status(400).json({ error: "amount_clp and received_on required" });
    return;
  }
  const r = db
    .prepare(
      `INSERT INTO income_entries (amount_clp, received_on, source, note) VALUES (?, ?, ?, ?)`
    )
    .run(amount_clp, received_on, source ?? null, note ?? null);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

app.get("/api/expenses", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, amount_clp, spent_on, category, note, import_batch_id FROM expense_entries ORDER BY spent_on DESC, id DESC`
    )
    .all();
  res.json({ expenses: rows });
});

app.post("/api/expenses", (req, res) => {
  const { amount_clp, spent_on, category, note } = req.body as {
    amount_clp?: number;
    spent_on?: string;
    category?: string;
    note?: string;
  };
  if (!amount_clp || amount_clp <= 0 || !spent_on) {
    res.status(400).json({ error: "positive amount_clp and spent_on required" });
    return;
  }
  const r = db
    .prepare(
      `INSERT INTO expense_entries (amount_clp, spent_on, category, note) VALUES (?, ?, ?, ?)`
    )
    .run(amount_clp, spent_on, category ?? null, note ?? null);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

/** Placeholder for future bank CSV / PDF pipeline */
app.post("/api/imports/bank-statement", (req, res) => {
  const { filename, raw_text } = req.body as { filename?: string; raw_text?: string };
  const r = db
    .prepare(
      `INSERT INTO import_batches (kind, filename, status, raw_text) VALUES ('bank_statement', ?, 'pending', ?)`
    )
    .run(filename ?? null, raw_text ?? null);
  res.status(201).json({ id: Number(r.lastInsertRowid), status: "pending" });
});

app.listen(PORT, () => {
  console.log(`nw-tracker API http://localhost:${PORT}`);
});
