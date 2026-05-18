import cors from "cors";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getMergedDepositInflowEventsForAccount,
  getMergedDisplayDepositInflowEventsForAccount,
  getStateContributionInflowEventsForAccount,
  totalDepositsClpWithStocksSheetFloor,
  totalDisplayDepositsClpForAccount,
  totalStateContributionsClpForAccount,
  totalWithdrawalsClpForAccount,
} from "./accountDeposits.js";
import { movementFlowTypeFromSignedClp, movementFlowTypeLabel } from "./movementFlowType.js";
import { getAccountPositionMeta } from "./accountPosition.js";
import {
  accountUsesEquityMtm,
  computeEquityMtmClp,
  computeLatestDisplayedEquityClp,
  equityTickerForAccount,
} from "./brokerageEquityMtm.js";
import { accountCountsTowardGroupTotals } from "./accountGroupTotals.js";
import { NOTE_STOCKS_LEGACY, type DashboardAccountStats } from "./brokerageAcciones.js";
import {
  deptoSueciaDashboardSnapshotAt,
  isDeptoMortgagePaymentCuota,
  loadDeptoDividendosSheetLedger,
  mortgageMetaFromSheetRows,
  noteIsDeptoPiePayment,
} from "./deptoDividendosLedger.js";
import { buildDeptoPaymentScenarioRows } from "./mortgageScenarioPayments.js";
import { fxMonthEndForBalanceUsd } from "./fxRates.js";
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { latestValuationRowOnOrBeforeChileToday } from "./valuationLatest.js";
import type { AccountPositionMeta } from "./accountPosition.js";
import { getMarketSeriesPayload } from "./marketSeries.js";
import { liabilitiesBreakdownClpAsOf, liabilitiesGroupClpAsOf } from "./valuationTimeseries.js";
import {
  brokerageSubgroupMatchesCategory,
  getAccountValuationTimeseries,
  getDashboardValuationTimeseries,
  getGroupValuationTimeseries,
  retirementSubgroupMatchesAccount,
  type TsUnit,
} from "./valuationTimeseries.js";
import {
  getAccountMonthlyPerformance,
  getGroupMonthlyPerformanceSeries,
  getStocksLifetimeEarningsSeries,
} from "./accountPerformance.js";
import { accountCardPerformanceMetrics } from "./dashboardAccountCardMetrics.js";
import { creditCardInstallmentsResponse, parseExtraOffsetsJson } from "./creditCardInstallments.js";
import { resolveCfraserCsvDir, resolveDeptoDividendosCsvPath } from "./cfraserPaths.js";
import {
  buildFlowsDepositsPayload,
  depositClpToUsdAtDate,
  inversionesBrokerageDepositsSeries,
  flowsDepositsNetInPeriodByAccount,
  flowsDepositsNetTotalByAccount,
  flowsDepositsNetTotalUsdByAccount,
} from "./flowsDeposits.js";
import { syncStatusPayload } from "./globalSyncStale.js";
import { startGlobalSyncScheduler } from "./globalSyncScheduler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** `subgroup` for `group=brokerage` | `group=retirement`. Not used for `group=inversiones`. */
function parseClassTabSubgroupQuery(group: string, raw: unknown): string | undefined | null {
  if (raw == null || raw === "") return undefined;
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t === "") return undefined;
  if (group === "brokerage") {
    if (t === "fondos_mutuos") return "mutual_funds";
    if (t === "acciones" || t === "mutual_funds" || t === "crypto") return t;
    return null;
  }
  if (group === "retirement") {
    if (
      t === "afp" ||
      t === "afc" ||
      t === "afp_afc" ||
      t === "apv" ||
      t === "apv_a" ||
      t === "apv_a_principal" ||
      t === "apv_b"
    )
      return t;
    return null;
  }
  if (group === "inversiones") {
    return null;
  }
  return null;
}

function isKnownClassTabGroup(group: string): boolean {
  if (group === "inversiones") return true;
  const ok = db.prepare(`SELECT 1 AS o FROM asset_groups WHERE slug = ?`).get(group) as { o: number } | undefined;
  return Boolean(ok);
}

/**
 * Account detail + dashboard position row.
 * **AFP:** when we have Σ cuotas and a reputable **valor cuota** (`fund_unit_daily`), **valor hoy** is
 * `cuotas × valor_cuota` so the three columns are consistent. If either is missing, falls back to the latest
 * `valuations` row (e.g. Excel month-end) like other accounts.
 */
function positionSnapshotFromMeta(
  categorySlug: string | null | undefined,
  meta: AccountPositionMeta | null,
  deposits_clp: number,
  latest: { value_clp: number; as_of_date: string } | null | undefined
): {
  ticker: string;
  units_kind: "shares" | "coin";
  units: number | null;
  deposited_clp: number;
  value_clp: number | null;
  value_as_of: string | null;
  value_per_unit_clp: number | null;
} | null {
  if (meta == null) return null;
  const afp = categorySlug === "afp";
  const crypto = categorySlug === "bitcoin" || categorySlug === "eth";
  const v = latest?.value_clp;
  const units = meta.units;
  const ovc = meta.afp_override_value_clp;
  const mtmMark =
    (afp || crypto) && ovc != null && Number.isFinite(ovc) && (ovc > 0 || (crypto && ovc === 0));
  const afpMark = mtmMark;
  const value_clp = afpMark ? ovc : v != null && Number.isFinite(v) ? v : null;
  const value_as_of =
    afpMark
      ? meta.afp_override_value_as_of ?? null
      : latest?.as_of_date ?? null;
  const value_per_unit_clp =
    afp && meta.afp_override_valor_cuota_clp != null && Number.isFinite(meta.afp_override_valor_cuota_clp)
      ? meta.afp_override_valor_cuota_clp
      : v != null && units != null && units > 0 && Number.isFinite(v) && Number.isFinite(units)
        ? v / units
        : null;
  return {
    ticker: meta.ticker,
    units_kind: meta.units_kind,
    units,
    deposited_clp: deposits_clp,
    value_clp,
    value_as_of,
    value_per_unit_clp,
  };
}

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
  if (!groupSlug) {
    const rows = db
      .prepare(
        `SELECT a.id, a.name, a.notes, a.created_at, a.exclude_from_group_totals,
           c.slug AS category_slug, c.label AS category_label,
           g.slug AS group_slug, g.label AS group_label
    FROM accounts a
    JOIN categories c ON c.id = a.category_id
    JOIN asset_groups g ON g.id = c.group_id
    WHERE (a.notes IS NULL OR a.notes != ?)
      AND (g.slug != 'brokerage' OR c.slug != 'individual_stocks')
    ORDER BY g.sort_order, c.sort_order, a.name`
      )
      .all(NOTE_STOCKS_LEGACY) as Record<string, unknown>[];
    res.json({ accounts: rows });
    return;
  }
  const subRaw = parseClassTabSubgroupQuery(groupSlug, req.query.subgroup);
  if (groupSlug !== "brokerage" && groupSlug !== "retirement" && subRaw !== undefined && subRaw !== null) {
    res.status(400).json({ error: "subgroup is only valid with group=brokerage or group=retirement" });
    return;
  }
  if (subRaw === null) {
    res.status(400).json({
      error:
        "invalid subgroup (brokerage: acciones, mutual_funds, fondos_mutuos alias, crypto; retirement: afp, afp_afc, apv, afc, apv_a, apv_a_principal, apv_b)",
    });
    return;
  }

  let sql = `
    SELECT a.id, a.name, a.notes, a.created_at, a.exclude_from_group_totals,
           c.slug AS category_slug, c.label AS category_label,
           g.slug AS group_slug, g.label AS group_label
    FROM accounts a
    JOIN categories c ON c.id = a.category_id
    JOIN asset_groups g ON g.id = c.group_id
    WHERE (a.notes IS NULL OR a.notes != ?)
      AND (g.slug != 'brokerage' OR c.slug != 'individual_stocks')
  `;
  const params: string[] = [NOTE_STOCKS_LEGACY];
  if (groupSlug === "brokerage") {
    sql += ` AND g.slug = 'brokerage' AND c.slug != 'individual_stocks'`;
  } else if (groupSlug === "inversiones") {
    sql += ` AND (g.slug = 'retirement' OR (g.slug = 'brokerage' AND c.slug != 'individual_stocks'))`;
  } else if (groupSlug) {
    sql += ` AND g.slug = ?`;
    params.push(groupSlug);
  }
  sql += ` ORDER BY g.sort_order, c.sort_order, a.name`;
  let rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  if (groupSlug === "brokerage" && typeof subRaw === "string") {
    rows = rows.filter((r) => brokerageSubgroupMatchesCategory(String(r.category_slug), subRaw));
  }
  if (groupSlug === "retirement" && typeof subRaw === "string") {
    rows = rows.filter((r) =>
      retirementSubgroupMatchesAccount(
        { category_slug: String(r.category_slug), notes: (r.notes as string | null) ?? null },
        subRaw
      )
    );
  }
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
  const displayEvents = getMergedDisplayDepositInflowEventsForAccount(id);
  const stateEvents = getStateContributionInflowEventsForAccount(id);
  const total_clp = totalDepositsClpWithStocksSheetFloor(id, catRow?.category_slug ?? "");
  const display_total_clp = totalDisplayDepositsClpForAccount(id);
  let cumulative_clp = 0;
  const events_with_cumulative = events.map((e) => {
    cumulative_clp += e.amt;
    return { occurred_on: e.occurred_on, amt_clp: e.amt, cumulative_clp };
  });
  let display_cumulative_clp = 0;
  const display_events = displayEvents.map((e) => {
    display_cumulative_clp += e.amt;
    return { occurred_on: e.occurred_on, amt_clp: e.amt, cumulative_clp: display_cumulative_clp };
  });
  let state_cumulative_clp = 0;
  const state_contribution_events = stateEvents.map((e) => {
    state_cumulative_clp += e.amt;
    return { occurred_on: e.occurred_on, amt_clp: e.amt, cumulative_clp: state_cumulative_clp };
  });
  res.json({
    account_id: id,
    total_clp,
    display_total_clp,
    events: events_with_cumulative,
    display_events,
    state_contribution_total_clp: totalStateContributionsClpForAccount(id),
    state_contribution_events,
  });
});

app.get("/api/accounts/:id/summary", (req, res) => {
  const id = Number(req.params.id);
  const withdrawals_clp = totalWithdrawalsClpForAccount(id);
  const cat = db
    .prepare(
      `SELECT c.slug AS category_slug, g.slug AS group_slug, g.label AS group_label,
        (
          SELECT COUNT(*) FROM accounts a2
          JOIN categories c2 ON c2.id = a2.category_id
          JOIN asset_groups g2 ON g2.id = c2.group_id
          WHERE g2.slug = g.slug
            AND (a2.notes IS NULL OR a2.notes != ?)
            AND (g2.slug != 'brokerage' OR c2.slug != 'individual_stocks')
            AND COALESCE(a2.exclude_from_group_totals, 0) = 0
        ) AS group_peer_count
       FROM accounts a
       JOIN categories c ON c.id = a.category_id
       JOIN asset_groups g ON g.id = c.group_id
       WHERE a.id = ?`
    )
    .get(NOTE_STOCKS_LEGACY, id) as
    | {
        category_slug: string;
        group_slug: string;
        group_label: string;
        group_peer_count: number;
      }
    | undefined;
  const deposits_clp = totalDepositsClpWithStocksSheetFloor(id, cat?.category_slug ?? "");
  const maxEqDateStmt = db.prepare(
    `SELECT max(trade_date) AS md FROM equity_daily WHERE ticker = ?`
  );
  let latest = latestValuationRowOnOrBeforeChileToday(id);
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
  const asOfCuotas = latest?.as_of_date ?? chileCalendarTodayYmd();
  const positionMeta = cat
    ? getAccountPositionMeta(
        id,
        cat.category_slug,
        cat.category_slug === "afp" ? { afpCuotasAsOfYmd: asOfCuotas } : undefined
      )
    : null;
  const position = positionSnapshotFromMeta(cat?.category_slug ?? null, positionMeta, deposits_clp, latest ?? undefined);
  let latest_valuation_clp = latest?.value_clp ?? null;
  let latest_valuation_date = latest?.as_of_date ?? null;
  if (cat?.category_slug === "afp" && position?.value_clp != null) {
    latest_valuation_clp = position.value_clp;
    if (position.value_as_of != null) latest_valuation_date = position.value_as_of;
  }
  res.json({
    account_id: id,
    category_slug: cat?.category_slug ?? null,
    group_slug: cat?.group_slug ?? null,
    group_label: cat?.group_label ?? null,
    group_peer_count: cat?.group_peer_count ?? null,
    deposits_clp,
    withdrawals_clp,
    latest_valuation_clp,
    latest_valuation_date,
    position,
  });
});

app.get("/api/accounts/:id/movements", (req, res) => {
  const id = Number(req.params.id);
  const cat = db
    .prepare(
      `SELECT c.slug AS category_slug FROM accounts a JOIN categories c ON c.id = a.category_id WHERE a.id = ?`
    )
    .get(id) as { category_slug: string } | undefined;
  let rows = db
    .prepare(
      `SELECT id, amount_clp, occurred_on, note, units_delta FROM movements WHERE account_id = ? ORDER BY occurred_on DESC, id DESC`
    )
    .all(id) as {
    id: number;
    amount_clp: number;
    occurred_on: string;
    note: string | null;
    units_delta: number | null;
  }[];
  if (cat?.category_slug === "mortgage") {
    rows = rows.filter((r) => !noteIsDeptoPiePayment(r.note));
  }
  res.json({
    movements: rows.map((r) => {
      const flow_type = movementFlowTypeFromSignedClp(r.note, r.amount_clp, id, r.id, r.occurred_on);
      return {
        ...r,
        flow_type,
        flow_type_label: movementFlowTypeLabel(flow_type),
      };
    }),
  });
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
  if (row.category_slug === "property" || row.category_slug === "mortgage") {
    const dir = resolveCfraserCsvDir();
    const absCsv = resolveDeptoDividendosCsvPath();
    const sheetRowsAll = loadDeptoDividendosSheetLedger(dir);
    const sheetRows =
      row.category_slug === "mortgage"
        ? sheetRowsAll.filter((r) => isDeptoMortgagePaymentCuota(r.cuota))
        : sheetRowsAll;
    const payment_scenarios = buildDeptoPaymentScenarioRows(dir, sheetRowsAll);
    const meta = {
      ...mortgageMetaFromSheetRows(sheetRowsAll, csvRel),
      csv_absolute_path: absCsv,
      csv_file_exists: fs.existsSync(absCsv),
    };
    res.json({
      account_id: id,
      source: "csv" as const,
      meta,
      rows: sheetRows,
      payment_scenarios,
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

/** Tarjeta de crédito: cupos desde SQLite (PDF import) si hay filas; si no, desde `cfraser/credit-card-installments.csv`. */
app.get("/api/accounts/:id/cc-installments", (req, res) => {
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
  if (row.category_slug !== "credit_card") {
    res.json({
      account_id: id,
      source: "none" as const,
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
  const extra = parseExtraOffsetsJson(req.query.extraOffsets);
  res.json(creditCardInstallmentsResponse(id, extra));
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

  const maxEqDateStmt = db.prepare(
    `SELECT max(trade_date) AS md FROM equity_daily WHERE ticker = ?`
  );

  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const depositsNetByAccount = flowsDepositsNetTotalByAccount();
  const depositsNetUsdByAccount = includeUsd ? flowsDepositsNetTotalUsdByAccount() : null;
  const depositsMonth = flowsDepositsNetInPeriodByAccount("month");
  const depositsYear = flowsDepositsNetInPeriodByAccount("year");
  const DASHBOARD_ASSET_METRIC_GROUPS = new Set(["real_estate", "retirement", "brokerage", "cash_eqs"]);

  const rowsBuilt: DashboardAccountStats[] = accounts.map((a) => {
    const deposits = depositsNetByAccount.get(a.id) ?? 0;
    const deposits_usd = depositsNetUsdByAccount?.get(a.id) ?? null;
    const trackAssetMetrics = DASHBOARD_ASSET_METRIC_GROUPS.has(a.group_slug);
    const perfClp = trackAssetMetrics ? accountCardPerformanceMetrics(a.id, "clp") : null;
    const perfUsd =
      trackAssetMetrics && includeUsd ? accountCardPerformanceMetrics(a.id, "usd") : null;
    let v = latestValuationRowOnOrBeforeChileToday(a.id);
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
    const asOfCuotas = v?.as_of_date ?? chileCalendarTodayYmd();
    const positionMeta = getAccountPositionMeta(
      a.id,
      a.category_slug,
      a.category_slug === "afp" ? { afpCuotasAsOfYmd: asOfCuotas } : undefined
    );
    const position = positionSnapshotFromMeta(a.category_slug, positionMeta, deposits, v ?? undefined);
    let current_value_clp = v?.value_clp ?? null;
    let valuation_as_of = v?.as_of_date ?? null;
    if (a.category_slug === "afp" && position?.value_clp != null) {
      current_value_clp = position.value_clp;
      if (position.value_as_of != null) valuation_as_of = position.value_as_of;
    }
    const fxRow = includeUsd ? fxMonthEndForBalanceUsd(valuation_as_of ?? null) : null;
    const current_value_usd =
      includeUsd && current_value_clp != null && fxRow != null
        ? current_value_clp / fxRow.clp_per_usd
        : null;
    const fx_date_used = fxRow?.date ?? null;
    const fx_clp_per_usd = fxRow?.clp_per_usd ?? null;
    return {
      account_id: a.id,
      name: a.name,
      group_slug: a.group_slug,
      group_label: a.group_label,
      category_slug: a.category_slug,
      category_label: a.category_label,
      deposits_clp: deposits,
      deposits_usd: includeUsd ? deposits_usd : undefined,
      delta_month_clp: perfClp?.delta_month,
      delta_month_usd: perfUsd?.delta_month,
      delta_year_clp: perfClp?.delta_year,
      delta_year_usd: perfUsd?.delta_year,
      delta_total_clp: perfClp?.delta_total,
      delta_total_usd: perfUsd?.delta_total,
      deposits_month_clp: trackAssetMetrics ? (depositsMonth.clp.get(a.id) ?? 0) : undefined,
      deposits_month_usd: trackAssetMetrics
        ? (depositsMonth.usd.get(a.id) ?? null)
        : undefined,
      deposits_year_clp: trackAssetMetrics ? (depositsYear.clp.get(a.id) ?? 0) : undefined,
      deposits_year_usd: trackAssetMetrics ? (depositsYear.usd.get(a.id) ?? null) : undefined,
      current_value_clp,
      valuation_as_of,
      current_value_usd,
      fx_clp_per_usd,
      fx_date_used,
      notes: a.notes ?? null,
      position,
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
    if (!accountCountsTowardGroupTotals(r.account_id)) continue;
    addToBucket(bucketTotals, r.group_slug, r.current_value_clp, includeUsd ? r.current_value_usd : null);
  }

  const getBucket = (slug: string) => bucketTotals.get(slug) ?? { clp: 0, usd: 0 };
  const re = getBucket("real_estate");
  const ret = getBucket("retirement");
  const bro = getBucket("brokerage");
  const cash = getBucket("cash_eqs");
  const lia = getBucket("liabilities");
  const liabilities_clp_aligned = liabilitiesGroupClpAsOf(chileCalendarTodayYmd(), {
    mortgageFromDeptoSheet: true,
  });

  const netWorthClp = re.clp + ret.clp + bro.clp + cash.clp;
  const netWorthUsd = includeUsd ? re.usd + ret.usd + bro.usd + cash.usd : null;

  const depositsFlow = buildFlowsDepositsPayload();
  const totalDeposits = depositsFlow.net_total_clp;

  const byGroup = new Map<string, { label: string; value_clp: number; value_usd: number }>();
  for (const r of rowsBuilt) {
    if (r.current_value_clp == null) continue;
    if (!accountCountsTowardGroupTotals(r.account_id)) continue;
    const slug = r.group_slug;
    const cur = byGroup.get(slug) ?? {
      label: r.group_label,
      value_clp: 0,
      value_usd: 0,
    };
    cur.value_clp += r.current_value_clp;
    if (r.current_value_usd != null && Number.isFinite(r.current_value_usd)) cur.value_usd += r.current_value_usd;
    byGroup.set(slug, cur);
  }

  const clientAccounts = rowsBuilt.map(({ notes, ...rest }) => ({
    ...rest,
    notes: notes ?? null,
  }));

  const asOfToday = chileCalendarTodayYmd();
  const deptoLedger = loadDeptoDividendosSheetLedger(resolveCfraserCsvDir());
  const sueciaRaw = deptoSueciaDashboardSnapshotAt(asOfToday, deptoLedger);
  const suecia_snapshot = sueciaRaw
    ? {
        ...sueciaRaw,
        valor_usd: depositClpToUsdAtDate(sueciaRaw.valor_clp, asOfToday),
        net_value_usd: depositClpToUsdAtDate(sueciaRaw.net_value_clp, asOfToday),
        mortgage_usd: depositClpToUsdAtDate(sueciaRaw.mortgage_clp, asOfToday),
      }
    : null;
  const liabilitiesClp = liabilitiesBreakdownClpAsOf(asOfToday, {
    mortgageFromDeptoSheet: true,
  });
  const liabilities_breakdown = {
    mortgage_clp: liabilitiesClp.mortgage_clp,
    credit_card_clp: liabilitiesClp.credit_card_clp,
    mortgage_usd: depositClpToUsdAtDate(liabilitiesClp.mortgage_clp, asOfToday),
    credit_card_usd: depositClpToUsdAtDate(liabilitiesClp.credit_card_clp, asOfToday),
  };

  res.json({
    totals: {
      net_worth_clp: netWorthClp,
      deposits_clp: totalDeposits,
      real_estate_clp: re.clp,
      retirement_clp: ret.clp,
      brokerage_clp: bro.clp,
      cash_eqs_clp: cash.clp,
      liabilities_clp: liabilities_clp_aligned,
      ...(includeUsd
        ? {
            net_worth_usd: netWorthUsd,
            deposits_usd: depositsFlow.net_total_usd,
            real_estate_usd: re.usd,
            retirement_usd: ret.usd,
            brokerage_usd: bro.usd,
            cash_eqs_usd: cash.usd,
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
    suecia_snapshot,
    liabilities_breakdown,
    deposits_by_category: depositsFlow.by_category,
    inversiones_deposits_chart: {
      monthly_clp: inversionesBrokerageDepositsSeries(depositsFlow.chart_monthly),
      yearly_clp: inversionesBrokerageDepositsSeries(depositsFlow.chart_yearly),
      ...(includeUsd
        ? {
            monthly_usd: inversionesBrokerageDepositsSeries(depositsFlow.chart_monthly_usd),
            yearly_usd: inversionesBrokerageDepositsSeries(depositsFlow.chart_yearly_usd),
          }
        : {}),
    },
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
    if (!isKnownClassTabGroup(group)) {
      res.status(400).json({ error: "unknown group slug" });
      return;
    }
    const sub = parseClassTabSubgroupQuery(group, req.query.subgroup);
    if (group !== "brokerage" && group !== "retirement" && sub !== undefined && sub !== null) {
      res.status(400).json({ error: "subgroup is only valid with group=brokerage or group=retirement" });
      return;
    }
    if (sub === null) {
      res.status(400).json({
        error:
          "invalid subgroup (brokerage: acciones, mutual_funds, fondos_mutuos alias, crypto; retirement: afp, afp_afc, apv, afc, apv_a, apv_a_principal, apv_b)",
      });
      return;
    }
    res.json(getGroupValuationTimeseries(group, unit, typeof sub === "string" ? sub : undefined));
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
  if (!isKnownClassTabGroup(slug)) {
    res.status(400).json({ error: "unknown group slug" });
    return;
  }
  const sub = parseClassTabSubgroupQuery(slug, req.query.subgroup);
  if (slug !== "brokerage" && slug !== "retirement" && sub !== undefined && sub !== null) {
    res.status(400).json({ error: "subgroup is only valid for brokerage or retirement" });
    return;
  }
  if (sub === null) {
    res.status(400).json({
      error:
        "invalid subgroup (brokerage: acciones, mutual_funds, fondos_mutuos alias, crypto; retirement: afp, afp_afc, apv, afc, apv_a, apv_a_principal, apv_b)",
    });
    return;
  }
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const unit: TsUnit = includeUsd ? "usd" : "clp";
  res.json(getGroupMonthlyPerformanceSeries(slug, unit, typeof sub === "string" ? sub : undefined));
});

app.get("/api/accounts/:id/brokerage-flows", (req, res) => {
  const id = Number(req.params.id);
  const rows = db
    .prepare(
      `SELECT id, occurred_on, flow_kind, amount_clp, amount_usd, ticker, note, units_delta
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

app.get("/api/flows/deposits", (_req, res) => {
  res.json(buildFlowsDepositsPayload());
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

/** Stale external sources + last sync state (AFP / Fintual / SBIF). */
app.get("/api/sync/status", (_req, res) => {
  res.json(syncStatusPayload());
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
  startGlobalSyncScheduler();
});
