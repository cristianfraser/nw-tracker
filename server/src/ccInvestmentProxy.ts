/**
 * Investment proxy: for each CC purchase (installment or normal), simulate investing the
 * purchase amount on the purchase date and selling each slice on the pay-by of the facturación
 * that billed it. Computes "potential realized earnings" per tracked ticker, keyed by that
 * facturación so the facturaciones table shows each gain on the row that billed the money.
 *
 * Computed overlay only — not persisted, not part of net worth.
 */
import { db } from "./db.js";
import { fxRowOnOrBefore } from "./fxRates.js";
import { ufYoyAnnualRate } from "./watchlistStats.js";
import { addCalendarMonths, parseYearMonth } from "./ccYearMonth.js";
import { normalizeTransactionDateIso } from "./ccInstallmentPayBy.js";
import { facturacionMonthByStatementDate } from "./ccOpenWebPastePdfReconcile.js";
import { oneShotStatementLineIdsSupersededByInstallmentPurchases } from "./ccCrossImportDedupe.js";
import { facturacionPayByIsoResolver, type CcFacturacionRow } from "./ccBillingViews.js";

// ─── Ticker config ───────────────────────────────────────────────────────────

export const CC_PROXY_TICKERS_KEY = "cc_proxy_tickers";
export const CC_PROXY_DEFAULT_TICKERS = ["fintual_cert_reserva2"] as const;

const stmtGetSetting = db.prepare(`SELECT value FROM app_settings WHERE key = ?`);

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

// ─── Price helper ─────────────────────────────────────────────────────────────

const stmtFundUnitOnOrBefore = db.prepare(
  `SELECT day, unit_value_clp FROM fund_unit_daily WHERE series_key = ? AND day <= ? ORDER BY day DESC LIMIT 1`
);
const stmtFundUnitLatest = db.prepare(
  `SELECT day, unit_value_clp FROM fund_unit_daily WHERE series_key = ? ORDER BY day DESC LIMIT 1`
);
const stmtEquityLatest = db.prepare(
  `SELECT trade_date, close, currency FROM equity_daily WHERE ticker = ? ORDER BY trade_date DESC LIMIT 1`
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
  const eq = stmtEquityLatest.get(ticker) as { close: number; currency: string } | undefined;
  if (eq == null || !Number.isFinite(eq.close) || eq.close <= 0) return false;
  if (eq.currency === "clp") return true;
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
 * - Equity (SPY, VEA, etc.): equity_daily.close × fx_daily.clp_per_usd (CLP-quoted tickers use close directly)
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

  // Equity ticker: quote-currency price (+ CLP/USD FX for USD-quoted tickers)
  const eodRow = db
    .prepare(
      `SELECT trade_date, close, currency FROM equity_daily WHERE ticker = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 1`
    )
    .get(ticker, ymd) as { trade_date: string; close: number; currency: string } | undefined;

  if (eodRow != null && Number.isFinite(eodRow.close) && eodRow.close > 0) {
    if (eodRow.currency === "clp") {
      return { priceClp: eodRow.close, projected: false, lastRealDate: eodRow.trade_date };
    }
    const fx = fxRowOnOrBefore(eodRow.trade_date);
    if (fx == null || fx.clp_per_usd <= 0) {
      throw new Error(`ccInvestmentProxy: no FX rate for date ${eodRow.trade_date} (ticker ${ticker})`);
    }
    return {
      priceClp: eodRow.close * fx.clp_per_usd,
      projected: false,
      lastRealDate: eodRow.trade_date,
    };
  }

  // Project forward from latest
  const latest = stmtEquityLatest.get(ticker) as
    | { trade_date: string; close: number; currency: string }
    | undefined;
  if (latest == null || !Number.isFinite(latest.close) || latest.close <= 0) {
    throw new Error(`ccInvestmentProxy: no price data for equity ticker "${ticker}"`);
  }
  if (latest.currency === "clp") {
    return {
      priceClp: projectPrice(latest.close, latest.trade_date, ymd),
      projected: true,
      lastRealDate: latest.trade_date,
    };
  }
  const fxRow = (stmtFxLatest.get() as { date: string; clp_per_usd: number } | undefined);
  if (fxRow == null || fxRow.clp_per_usd <= 0) {
    throw new Error(`ccInvestmentProxy: no FX data for equity projection (ticker ${ticker})`);
  }
  const lastKnownClp = latest.close * fxRow.clp_per_usd;
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
  /**
   * Sorted ascending by date. Each entry maps to one cuota or normal-purchase payment: `date` is
   * the pay-by of the facturación that billed it, `billing_month` that facturación (YYYY-MM).
   */
  withdrawals: { amount_clp: number; date: string; billing_month: string }[];
};

/**
 * Per-cuota gain result.
 *
 * realized_gain_clp     = cuota_amount × (price_at_pay_by / depositPrice − 1)
 *   = appreciation withdrawn with that cuota (its own slice's float, deposit → pay_by).
 * total_gain_so_far_clp = the whole purchase's P/L at this cuota's date: gains already
 *   withdrawn by cuotas ≤ i, plus the open gain on the principal still invested after
 *   this withdrawal. At cuota 1 of an unbilled plan that is the full purchase amount's
 *   appreciation; at the last cuota nothing is left invested, so it converges to Σ realized.
 * total_return_so_far_pct = total_gain_so_far_clp / purchase principal.
 * projected             = true if depositPrice or this cuota's price was projected (UF-YoY).
 * billing_month         = the facturación that billed this slice (not its pay-by month).
 */
export type ProxyCuotaResult = {
  pay_by_date: string;
  billing_month: string;
  cuota_amount_clp: number;
  realized_gain_clp: number;
  total_gain_so_far_clp: number;
  total_return_so_far_pct: number;
  projected: boolean;
};

export type ProxyTickerResult = {
  /** The purchase's proxy P/L so far = the last cuota's `total_gain_so_far_clp`. */
  gain_clp: number;
  /** `gain_clp` over the deposited principal. */
  return_pct: number;
  projected: boolean;
  cuotas: ProxyCuotaResult[];
};

export type ProxyLotResult = {
  by_ticker: Record<string, ProxyTickerResult>;
};

/**
 * Pure helper: compute per-cuota gains given the deposited principal, a depositPrice
 * and a price lookup function. DB-free so it can be unit-tested with a price map.
 *
 * Model: the whole purchase amount is deposited on the purchase date and each cuota
 * withdraws its slice at its pay-by, so
 *   realized_i = cuota_amount_i × (price_i / depositPrice − 1)
 *   total_i    = Σ_{j≤i} realized_j + (principal − Σ_{j≤i} cuota_amount_j) × (price_i/depositPrice − 1)
 * i.e. earmarked accounting: each slice keeps the appreciation of its own float and the
 * unwithdrawn remainder is marked at the same date. Gains are not reinvested (the
 * compounding that would add is second-order over a few weeks, and keeping the split
 * additive is what makes per-cuota attribution sum to the purchase total).
 *
 * Past cuotas (pay_by ≤ today): use actual price at pay_by.
 * Future cuotas (pay_by > today): use today's price as proxy. projected = true.
 */
export function realizedCuotaGains(
  principalClp: number,
  depositPrice: number,
  depositProjected: boolean,
  withdrawals: ProxyLot["withdrawals"],
  priceLookup: (ymd: string) => { priceClp: number; projected: boolean },
  today: string
): ProxyCuotaResult[] {
  let realizedTotal = 0;
  let withdrawnTotal = 0;
  return withdrawals.map((w) => {
    const isPast = w.date <= today;
    const { priceClp, projected: priceProjected } = isPast
      ? priceLookup(w.date)
      : priceLookup(today); // use today's price for future cuotas
    // Future cuotas are always projected (we're substituting today's price)
    const isProjected = depositProjected || priceProjected || !isPast;
    const growth = priceClp / depositPrice - 1;
    const realized = w.amount_clp * growth;
    realizedTotal += realized;
    withdrawnTotal += w.amount_clp;
    const stillInvested = Math.max(0, principalClp - withdrawnTotal);
    const totalSoFar = realizedTotal + stillInvested * growth;
    return {
      pay_by_date: w.date,
      billing_month: w.billing_month,
      cuota_amount_clp: w.amount_clp,
      realized_gain_clp: realized,
      total_gain_so_far_clp: totalSoFar,
      total_return_so_far_pct: principalClp > 0 ? (totalSoFar / principalClp) * 100 : 0,
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
      lot.deposit.amount_clp,
      depositPriceResult.priceClp,
      depositPriceResult.projected,
      lot.withdrawals,
      (ymd) => {
        const r = priceClpForTickerAt(ticker, ymd);
        return { priceClp: r.priceClp, projected: r.projected };
      },
      today
    );

    // The purchase's P/L at its latest cuota — already carries both the withdrawn slices'
    // realized gains and the open gain on principal not yet billed.
    const gain_clp = cuotas.length > 0 ? cuotas[cuotas.length - 1]!.total_gain_so_far_clp : 0;
    const principal = lot.deposit.amount_clp;
    const return_pct = principal > 0 ? (gain_clp / principal) * 100 : 0;
    const projected = cuotas.some((c) => c.projected);

    by_ticker[ticker] = { gain_clp, return_pct, projected, cuotas };
  }

  return { by_ticker };
}

// ─── Lot builders ─────────────────────────────────────────────────────────────

/**
 * Build a proxy lot for a DB-source installment purchase.
 * deposit date = purchase_date (the money is float from the moment you buy, same framing
 *   as normalPurchaseToLot). Depositing at the first pay_by instead made cuota 1 a
 *   zero-length float — always exactly 0 gain — and dropped the purchase → first-pay-by
 *   stretch, the longest float in the lot, from every later cuota too.
 * withdrawals = each cuota a statement printed, sorted by date. It is keyed by the facturación
 *   that billed it: the month the plan schedule bills cuota N (`first_due_month` + N − 1, AGENTS.md
 *   «One schedule framing» — the month whose «cuota a pagar» carries it). It is withdrawn on that
 *   facturación's pay-by: the payment row's `pay_by_date`, which the import resolved the way the
 *   facturaciones table does (`resolveInstallmentPayByIso`: printed PAGAR HASTA, else derived).
 *   Keying by the pay-by month instead put every cuota's gain on the next facturación's row.
 */
export function installmentPurchaseToLot(purchase: {
  purchase_date?: string;
  first_due_month: string;
  payment_statements?: {
    pay_by_date: string;
    cuota_current: number | null;
    amount_clp: number;
  }[];
  principal_clp: number;
}): ProxyLot | null {
  const stmts = purchase.payment_statements;
  if (!stmts || stmts.length === 0) return null;
  // cc_installment_purchases.purchase_date is NOT NULL — a missing one is a broken lot,
  // not a case to guess a deposit date for.
  const purchaseDate = purchase.purchase_date;
  if (!purchaseDate) {
    throw new Error("ccInvestmentProxy: installment purchase has no purchase_date");
  }
  const firstDueYm = parseYearMonth(purchase.first_due_month);
  if (!firstDueYm) {
    throw new Error(
      `ccInvestmentProxy: installment purchase ${purchaseDate} has no valid first_due_month («${purchase.first_due_month}»)`
    );
  }
  const withdrawals = stmts.map((s) => {
    const cuota = s.cuota_current;
    if (cuota == null || !Number.isInteger(cuota) || cuota < 1) {
      throw new Error(`ccInvestmentProxy: installment payment of purchase ${purchaseDate} has no cuota index`);
    }
    const payBy = normalizeTransactionDateIso(s.pay_by_date);
    if (!payBy) {
      throw new Error(
        `ccInvestmentProxy: cuota ${cuota} of purchase ${purchaseDate} has no parseable pay-by («${s.pay_by_date}»)`
      );
    }
    return { amount_clp: s.amount_clp, date: payBy, billing_month: addCalendarMonths(firstDueYm, cuota - 1) };
  });
  withdrawals.sort((a, b) => a.date.localeCompare(b.date) || a.billing_month.localeCompare(b.billing_month));
  return {
    deposit: { amount_clp: purchase.principal_clp, date: purchaseDate },
    withdrawals,
  };
}

/**
 * Build a proxy lot for a normal (non-installment) purchase.
 * deposit date = purchase_on (real transaction date).
 * withdrawal = the pay-by of the facturación that billed it (`billing_month`).
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
 * Each lot carries `by_ticker[t].cuotas[]`, each with the facturación that billed it
 * (`billing_month`, the key the facturaciones table looks up). A 12-cuota purchase distributes
 * across 12 facturaciones.
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
         l.merchant,
         l.amount_clp,
         l.transaction_date,
         l.posting_date,
         l.cuota_purchase_kind,
         s.statement_date
  FROM cc_statement_lines l
  JOIN cc_statements s ON s.id = l.statement_id
  WHERE s.account_id = ?
    AND l.installment_flag = 0
    AND l.amount_clp > 0
  ORDER BY l.id
`);

type NormalPurchaseRow = {
  statement_line_id: number;
  merchant: string | null;
  amount_clp: number;
  transaction_date: string | null;
  posting_date: string | null;
  cuota_purchase_kind: string | null;
  statement_date: string;
};

/**
 * Build proxy lots for all normal (non-installment, positive CLP) purchases for an account.
 * Keyed by statement_line_id.
 *
 * Each line belongs to the facturación its statement's lines belong to, by the one rule the
 * facturado and the facturación modal read (`facturacionMonthByStatementDate`: the statement's own
 * month; a stale open bucket's, the open month). It is withdrawn on that facturación's pay-by as the
 * facturaciones table resolves it (`facturaciones`, see `facturacionPayByIsoResolver`), so the web-paste
 * lines of the open and provisionally closed months take part: they have no printed PAGAR HASTA.
 *
 * Left out, as the facturado leaves them out: a line a plan supersedes (the plan's lot carries the
 * purchase) and a feed-typed cuota purchase still waiting for its count (not billed whole at this
 * facturación; its plan will carry it). A line with no parseable purchase date throws.
 */
export function buildNormalPurchaseProxyForAccount(
  accountId: number,
  tickers: string[],
  today: string,
  facturaciones: readonly Pick<CcFacturacionRow, "billing_month" | "pay_by_iso">[]
): {
  lineProxy: Map<number, ProxyLotResult>;
  lotResults: ProxyLotResult[];
} {
  const lineProxy = new Map<number, ProxyLotResult>();
  const lotResults: ProxyLotResult[] = [];
  const activeTickers = tickersWithData(tickers);
  if (activeTickers.length === 0) return { lineProxy, lotResults };
  const rows = stmtNormalPurchasesForAccount.all(accountId) as NormalPurchaseRow[];
  if (rows.length === 0) return { lineProxy, lotResults };

  const facturacionByStatementDate = facturacionMonthByStatementDate(accountId);
  const payByIsoFor = facturacionPayByIsoResolver(accountId, facturaciones);
  const superseded = oneShotStatementLineIdsSupersededByInstallmentPurchases(accountId);
  for (const row of rows) {
    if (row.cuota_purchase_kind != null || superseded.has(row.statement_line_id)) continue;
    const purchaseOn =
      normalizeTransactionDateIso(row.transaction_date) ?? normalizeTransactionDateIso(row.posting_date);
    if (!purchaseOn) {
      throw new Error(
        `ccInvestmentProxy: statement line ${row.statement_line_id} (${row.merchant ?? "?"}) has no parseable purchase date`
      );
    }
    const billingMonth = facturacionByStatementDate.get(row.statement_date);
    if (!billingMonth) {
      throw new Error(
        `ccInvestmentProxy: statement line ${row.statement_line_id}'s statement (${row.statement_date}) has no facturación`
      );
    }
    const lot = normalPurchaseToLot({
      amount_clp: row.amount_clp,
      purchase_on: purchaseOn,
      pay_by_iso: payByIsoFor(billingMonth),
      billing_month: billingMonth,
    });
    const result = computeProxyLot(lot, activeTickers, today);
    lineProxy.set(row.statement_line_id, result);
    lotResults.push(result);
  }

  return { lineProxy, lotResults };
}
