/**
 * Investment proxy: for each CC purchase (installment or normal), simulate
 * investing the purchase amount at the first pay-by date and selling at each
 * cuota payment date. Computes "potential realized earnings" per tracked ticker.
 *
 * Computed overlay only — not persisted, not part of net worth.
 */
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { fxRowOnOrBefore } from "./fxRates.js";
import { ufYoyAnnualRate } from "./watchlistStats.js";

// ─── Ticker config ───────────────────────────────────────────────────────────

export const CC_PROXY_TICKERS_KEY = "cc_proxy_tickers";
export const CC_PROXY_DEFAULT_TICKERS = ["fintual_cert_reserva2"] as const;
/** The ticker shown inline in each row (must be in the tracked list). */
export const CC_PROXY_INLINE_TICKER = "fintual_cert_reserva2";

const stmtGetSetting = db.prepare(`SELECT value FROM app_settings WHERE key = ?`);
const stmtUpsertSetting = db.prepare(
  `INSERT INTO app_settings (key, value) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);

export function getCcProxyTickers(): string[] {
  const row = stmtGetSetting.get(CC_PROXY_TICKERS_KEY) as { value: string } | undefined;
  if (row == null) return [...CC_PROXY_DEFAULT_TICKERS];
  try {
    const parsed = JSON.parse(row.value) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((t) => typeof t === "string")) {
      return parsed as string[];
    }
  } catch {
    // fall through
  }
  return [...CC_PROXY_DEFAULT_TICKERS];
}

export function setCcProxyTickers(tickers: string[]): void {
  stmtUpsertSetting.run(CC_PROXY_TICKERS_KEY, JSON.stringify(tickers));
}

// ─── Price helper ─────────────────────────────────────────────────────────────

const stmtFundUnitOnOrBefore = db.prepare(
  `SELECT day, unit_value_clp FROM fund_unit_daily WHERE series_key = ? AND day <= ? ORDER BY day DESC LIMIT 1`
);
const stmtFundUnitLatest = db.prepare(
  `SELECT day, unit_value_clp FROM fund_unit_daily WHERE series_key = ? ORDER BY day DESC LIMIT 1`
);
const stmtEquityLatest = db.prepare(
  `SELECT trade_date, close_usd FROM equity_daily WHERE ticker = ? ORDER BY trade_date DESC LIMIT 1`
);
const stmtFxLatest = db.prepare(
  `SELECT date, clp_per_usd FROM fx_daily ORDER BY date DESC LIMIT 1`
);

function isFundSeriesTicker(ticker: string): boolean {
  return ticker.includes("_") && !ticker.includes("-");
}

/**
 * Whether a ticker has *any* price data to work with (so it can be priced or
 * projected). Tickers with no data at all (e.g. GLD before backfill) are simply
 * not tracked yet — they are filtered out up front rather than throwing inside
 * computeProxyLot, which would otherwise drop every lot for the whole account.
 */
export function tickerHasAnyPriceData(ticker: string): boolean {
  if (isFundSeriesTicker(ticker)) {
    const row = stmtFundUnitLatest.get(ticker) as { unit_value_clp: number } | undefined;
    return row != null && Number.isFinite(row.unit_value_clp) && row.unit_value_clp > 0;
  }
  const eq = stmtEquityLatest.get(ticker) as { close_usd: number } | undefined;
  if (eq == null || !Number.isFinite(eq.close_usd) || eq.close_usd <= 0) return false;
  const fx = stmtFxLatest.get() as { clp_per_usd: number } | undefined;
  return fx != null && Number.isFinite(fx.clp_per_usd) && fx.clp_per_usd > 0;
}

/** Filter a ticker list to those that currently have price data. */
export function tickersWithData(tickers: string[]): string[] {
  return tickers.filter(tickerHasAnyPriceData);
}

/**
 * Price in CLP for a ticker at or before `ymd`.
 * - Fund series (e.g. fintual_cert_reserva2): fund_unit_daily.unit_value_clp
 * - Equity (SPY, VEA, etc.): equity_daily.close_usd × fx_daily.clp_per_usd
 *
 * If no real price exists at/before `ymd`, projects forward from the last known
 * price using the UF YoY annual rate (for future open-month pay_by dates).
 * Returns { priceClp, projected, lastRealDate }.
 *
 * Throws if there is no price at all for this ticker (can't even project).
 */
export function priceClpForTickerAt(
  ticker: string,
  ymd: string
): { priceClp: number; projected: boolean; lastRealDate: string } {
  if (isFundSeriesTicker(ticker)) {
    const row = stmtFundUnitOnOrBefore.get(ticker, ymd) as
      | { day: string; unit_value_clp: number }
      | undefined;
    if (row != null && Number.isFinite(row.unit_value_clp) && row.unit_value_clp > 0) {
      return { priceClp: row.unit_value_clp, projected: false, lastRealDate: row.day };
    }
    // Project forward
    const latest = stmtFundUnitLatest.get(ticker) as
      | { day: string; unit_value_clp: number }
      | undefined;
    if (latest == null || !Number.isFinite(latest.unit_value_clp) || latest.unit_value_clp <= 0) {
      throw new Error(`ccInvestmentProxy: no price data for fund series "${ticker}"`);
    }
    return {
      priceClp: projectPrice(latest.unit_value_clp, latest.day, ymd),
      projected: true,
      lastRealDate: latest.day,
    };
  }

  // Equity ticker: needs USD price + CLP/USD FX
  const eodRow = db
    .prepare(
      `SELECT trade_date, close_usd FROM equity_daily WHERE ticker = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 1`
    )
    .get(ticker, ymd) as { trade_date: string; close_usd: number } | undefined;

  if (eodRow != null && Number.isFinite(eodRow.close_usd) && eodRow.close_usd > 0) {
    const fx = fxRowOnOrBefore(eodRow.trade_date);
    if (fx == null || fx.clp_per_usd <= 0) {
      throw new Error(`ccInvestmentProxy: no FX rate for date ${eodRow.trade_date} (ticker ${ticker})`);
    }
    return {
      priceClp: eodRow.close_usd * fx.clp_per_usd,
      projected: false,
      lastRealDate: eodRow.trade_date,
    };
  }

  // Project forward from latest
  const latest = stmtEquityLatest.get(ticker) as
    | { trade_date: string; close_usd: number }
    | undefined;
  if (latest == null || !Number.isFinite(latest.close_usd) || latest.close_usd <= 0) {
    throw new Error(`ccInvestmentProxy: no price data for equity ticker "${ticker}"`);
  }
  const fxRow = (stmtFxLatest.get() as { date: string; clp_per_usd: number } | undefined);
  if (fxRow == null || fxRow.clp_per_usd <= 0) {
    throw new Error(`ccInvestmentProxy: no FX data for equity projection (ticker ${ticker})`);
  }
  const lastKnownClp = latest.close_usd * fxRow.clp_per_usd;
  return {
    priceClp: projectPrice(lastKnownClp, latest.trade_date, ymd),
    projected: true,
    lastRealDate: latest.trade_date,
  };
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const ms = Date.parse(toYmd) - Date.parse(fromYmd);
  return ms / 86_400_000;
}

function projectPrice(lastKnownClp: number, lastRealDate: string, targetYmd: string): number {
  const rate = ufYoyAnnualRate() ?? 0.04;
  const days = daysBetween(lastRealDate, targetYmd);
  if (days <= 0) return lastKnownClp;
  return lastKnownClp * Math.pow(1 + rate, days / 365);
}

// ─── Lot engine ───────────────────────────────────────────────────────────────

export type ProxyLot = {
  deposit: { amount_clp: number; date: string };
  /** Sorted ascending by date. Each entry maps to one cuota or normal-purchase payment. */
  withdrawals: { amount_clp: number; date: string; billing_month: string }[];
};

/**
 * Per-cuota realized gain result.
 *
 * realized_gain_clp  = cuota_amount × (price_at_pay_by / depositPrice − 1)
 *   = appreciation earned on that cuota's float from deposit date to pay_by.
 * accumulated_*      = running sum across all cuotas up to and including this one.
 * projected          = true if depositPrice or this cuota's price was projected (UF-YoY).
 */
export type ProxyCuotaResult = {
  pay_by_date: string;
  billing_month: string;
  cuota_amount_clp: number;
  realized_gain_clp: number;
  accumulated_gain_clp: number;
  accumulated_return_pct: number;
  projected: boolean;
};

export type ProxyTickerResult = {
  /** Total realized gain across all cuotas computed so far (past) + open gain on future ones. */
  gain_clp: number;
  return_pct: number;
  projected: boolean;
  cuotas: ProxyCuotaResult[];
};

export type ProxyLotResult = {
  by_ticker: Record<string, ProxyTickerResult>;
};

/**
 * Pure helper: compute per-cuota realized gains given a depositPrice and a price
 * lookup function. DB-free so it can be unit-tested with a price map.
 *
 * Model: each cuota earns the fund's appreciation over the float from deposit to pay_by.
 *   realized_gain_i = cuota_amount_i × (price_i / depositPrice − 1)
 *
 * Past cuotas (pay_by ≤ today): use actual price at pay_by.
 * Future cuotas (pay_by > today): use today's price as proxy → gain = cuota × (today_price/deposit − 1).
 *   projected = true.
 */
export function realizedCuotaGains(
  depositPrice: number,
  depositProjected: boolean,
  withdrawals: ProxyLot["withdrawals"],
  priceLookup: (ymd: string) => { priceClp: number; projected: boolean },
  today: string
): ProxyCuotaResult[] {
  let accumulated = 0;
  return withdrawals.map((w) => {
    const isPast = w.date <= today;
    const { priceClp, projected: priceProjected } = isPast
      ? priceLookup(w.date)
      : priceLookup(today); // use today's price for future cuotas
    // Future cuotas are always projected (we're substituting today's price)
    const isProjected = depositProjected || priceProjected || !isPast;
    const realized = w.amount_clp * (priceClp / depositPrice - 1);
    accumulated += realized;
    const principal = withdrawals.reduce((s, x) => s + x.amount_clp, 0);
    return {
      pay_by_date: w.date,
      billing_month: w.billing_month,
      cuota_amount_clp: w.amount_clp,
      realized_gain_clp: realized,
      accumulated_gain_clp: accumulated,
      accumulated_return_pct: principal > 0 ? (accumulated / principal) * 100 : 0,
      projected: isProjected,
    };
  });
}

/**
 * Compute proxy earnings for a single lot and a set of tickers.
 * today: YYYY-MM-DD for "current price" lookup.
 */
export function computeProxyLot(
  lot: ProxyLot,
  tickers: string[],
  today: string
): ProxyLotResult {
  const by_ticker: Record<string, ProxyTickerResult> = {};

  for (const ticker of tickers) {
    const depositPriceResult = priceClpForTickerAt(ticker, lot.deposit.date);
    const cuotas = realizedCuotaGains(
      depositPriceResult.priceClp,
      depositPriceResult.projected,
      lot.withdrawals,
      (ymd) => {
        const r = priceClpForTickerAt(ticker, ymd);
        return { priceClp: r.priceClp, projected: r.projected };
      },
      today
    );

    const gain_clp = cuotas.reduce((s, c) => s + c.realized_gain_clp, 0);
    const principal = lot.withdrawals.reduce((s, w) => s + w.amount_clp, 0);
    const return_pct = principal > 0 ? (gain_clp / principal) * 100 : 0;
    const projected = cuotas.some((c) => c.projected);

    by_ticker[ticker] = { gain_clp, return_pct, projected, cuotas };
  }

  return { by_ticker };
}

// ─── Lot builders ─────────────────────────────────────────────────────────────

/** YYYY-MM from an ISO date string. */
function ymFromIso(ymd: string): string {
  return ymd.slice(0, 7);
}

/**
 * Build a proxy lot for a DB-source installment purchase.
 * deposit date = first pay_by_date among payment_statements.
 * withdrawals = each payment statement entry, sorted by date.
 * Each withdrawal carries its billing_month (= YYYY-MM of pay_by_date).
 */
export function installmentPurchaseToLot(purchase: {
  payment_statements?: {
    pay_by_date: string;
    amount_clp: number;
  }[];
  principal_clp: number;
}): ProxyLot | null {
  const stmts = purchase.payment_statements;
  if (!stmts || stmts.length === 0) return null;
  const sorted = [...stmts].sort((a, b) => a.pay_by_date.localeCompare(b.pay_by_date));
  const firstPayBy = sorted[0]!.pay_by_date;
  return {
    deposit: { amount_clp: purchase.principal_clp, date: firstPayBy },
    withdrawals: sorted.map((s) => ({
      amount_clp: s.amount_clp,
      date: s.pay_by_date,
      billing_month: ymFromIso(s.pay_by_date),
    })),
  };
}

/**
 * Build a proxy lot for a normal (non-installment) purchase.
 * deposit date = purchase_on (real transaction date).
 * withdrawal = facturación pay_by_iso, billing_month from statement period.
 */
export function normalPurchaseToLot(opts: {
  amount_clp: number;
  purchase_on: string;
  pay_by_iso: string;
  billing_month: string;
}): ProxyLot {
  return {
    deposit: { amount_clp: opts.amount_clp, date: opts.purchase_on },
    withdrawals: [{ amount_clp: opts.amount_clp, date: opts.pay_by_iso, billing_month: opts.billing_month }],
  };
}

// ─── Facturación aggregation ──────────────────────────────────────────────────

export type ProxyFacturacionAggregate = {
  billing_month: string;
  by_ticker: Record<string, { total_gain_clp: number; blended_return_pct: number; projected: boolean }>;
};

/**
 * Aggregate per-cuota realized gains grouped by each cuota's own billing_month.
 *
 * Each lot carries `by_ticker[t].cuotas[]`, each with its own billing_month
 * (= YYYY-MM of pay_by_date). A 12-cuota purchase distributes across 12 months.
 *
 * blended_return_pct = total_gain_that_month / Σ cuota_amounts_that_month
 */
export function aggregateProxyByFacturacion(
  results: ProxyLotResult[],
  tickers: string[]
): ProxyFacturacionAggregate[] {
  // month → ticker → { gain, floated_amount, projected }
  const byMonth = new Map<string, Map<string, { gain: number; floated: number; projected: boolean }>>();

  for (const lotResult of results) {
    for (const ticker of tickers) {
      const tickerResult = lotResult.by_ticker[ticker];
      if (!tickerResult) continue;
      for (const cuota of tickerResult.cuotas) {
        const monthMap = byMonth.get(cuota.billing_month) ?? new Map();
        const existing = monthMap.get(ticker) ?? { gain: 0, floated: 0, projected: false };
        monthMap.set(ticker, {
          gain: existing.gain + cuota.realized_gain_clp,
          floated: existing.floated + cuota.cuota_amount_clp,
          projected: existing.projected || cuota.projected,
        });
        byMonth.set(cuota.billing_month, monthMap);
      }
    }
  }

  const months = [...byMonth.keys()].sort();
  return months.map((billing_month) => {
    const tickerMap = byMonth.get(billing_month)!;
    const by_ticker: Record<string, { total_gain_clp: number; blended_return_pct: number; projected: boolean }> = {};
    for (const ticker of tickers) {
      const agg = tickerMap.get(ticker);
      if (!agg) continue;
      by_ticker[ticker] = {
        total_gain_clp: agg.gain,
        blended_return_pct: agg.floated > 0 ? (agg.gain / agg.floated) * 100 : 0,
        projected: agg.projected,
      };
    }
    return { billing_month, by_ticker };
  });
}

// ─── Per-account normal purchase proxy ────────────────────────────────────────

const stmtNormalPurchasesForAccount = db.prepare(`
  SELECT l.id AS statement_line_id,
         l.amount_clp,
         l.transaction_date,
         l.posting_date,
         -- billing_month: prefer period_to, else statement_date (DD/MM/YYYY → YYYY-MM)
         CASE
           WHEN s.period_to IS NOT NULL AND s.period_to != ''
           THEN substr(s.period_to, 7, 4) || '-' || substr(s.period_to, 4, 2)
           ELSE substr(s.statement_date, 7, 4) || '-' || substr(s.statement_date, 4, 2)
         END AS billing_month,
         -- pay_by_iso: convert DD/MM/YYYY to YYYY-MM-DD
         CASE
           WHEN s.pay_by IS NOT NULL AND s.pay_by != ''
           THEN substr(s.pay_by, 7, 4) || '-' || substr(s.pay_by, 4, 2) || '-' || substr(s.pay_by, 1, 2)
           ELSE NULL
         END AS pay_by_iso
  FROM cc_statement_lines l
  JOIN cc_statements s ON s.id = l.statement_id
  WHERE s.account_id = ?
    AND l.installment_flag = 0
    AND l.amount_clp > 0
    AND l.amount_clp IS NOT NULL
  ORDER BY l.id
`);

type NormalPurchaseRow = {
  statement_line_id: number;
  amount_clp: number;
  transaction_date: string | null;
  posting_date: string | null;
  billing_month: string;
  pay_by_iso: string | null;
};

function isoFromDdMmYyyy(raw: string | null): string | null {
  if (!raw) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw.trim());
  if (!m) return raw.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Build proxy lots for all normal (non-installment, positive) purchases for an account.
 * Keyed by statement_line_id. Skips lines with no purchase date or no pay_by.
 */
export function buildNormalPurchaseProxyForAccount(
  accountId: number,
  tickers: string[],
  today: string
): {
  lineProxy: Map<number, ProxyLotResult>;
  lotResults: ProxyLotResult[];
} {
  const rows = stmtNormalPurchasesForAccount.all(accountId) as NormalPurchaseRow[];
  const lineProxy = new Map<number, ProxyLotResult>();
  const lotResults: ProxyLotResult[] = [];
  const activeTickers = tickersWithData(tickers);
  if (activeTickers.length === 0) return { lineProxy, lotResults };

  for (const row of rows) {
    const purchaseOn = isoFromDdMmYyyy(row.transaction_date) ?? isoFromDdMmYyyy(row.posting_date);
    if (!purchaseOn || !row.pay_by_iso || !row.billing_month) continue;
    const lot = normalPurchaseToLot({
      amount_clp: row.amount_clp,
      purchase_on: purchaseOn,
      pay_by_iso: row.pay_by_iso,
      billing_month: row.billing_month,
    });
    const result = computeProxyLot(lot, activeTickers, today);
    lineProxy.set(row.statement_line_id, result);
    lotResults.push(result);
  }

  return { lineProxy, lotResults };
}
